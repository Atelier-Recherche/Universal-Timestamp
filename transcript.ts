import { App, TFile } from 'obsidian';

export interface TranscriptSegment {
	start: number;
	stop: number;
	text: string;
}

/** Paragraphe affiché : plusieurs segments Vibe fusionnés (pause courte). */
export interface TranscriptParagraph {
	start: number;
	stop: number;
	text: string;
	firstSegmentIndex: number;
	lastSegmentIndex: number;
}

/** Regroupe les segments en paragraphes (saut de ligne seulement après une pause). */
export function groupTranscriptParagraphs(
	segments: TranscriptSegment[],
	pauseGapSeconds = 2
): TranscriptParagraph[] {
	const paragraphs: TranscriptParagraph[] = [];
	let current: TranscriptParagraph | null = null;

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const text = seg.text.trim();
		if (!text) {
			continue;
		}

		const gap = current ? seg.start - current.stop : pauseGapSeconds + 1;
		if (!current || gap > pauseGapSeconds) {
			if (current) {
				paragraphs.push(current);
			}
			current = {
				start: seg.start,
				stop: seg.stop,
				text,
				firstSegmentIndex: i,
				lastSegmentIndex: i
			};
		} else {
			current.text += ' ' + text;
			current.stop = seg.stop;
			current.lastSegmentIndex = i;
		}
	}

	if (current) {
		paragraphs.push(current);
	}

	return paragraphs;
}

export function findParagraphIndexAt(
	paragraphs: TranscriptParagraph[],
	offsetSeconds: number
): number {
	if (paragraphs.length === 0) {
		return -1;
	}

	for (let i = 0; i < paragraphs.length; i++) {
		const p = paragraphs[i];
		if (offsetSeconds >= p.start && offsetSeconds < p.stop) {
			return i;
		}
	}

	let closest = 0;
	let minDist = Math.abs(paragraphs[0].start - offsetSeconds);
	for (let i = 1; i < paragraphs.length; i++) {
		const dist = Math.abs(paragraphs[i].start - offsetSeconds);
		if (dist < minDist) {
			minDist = dist;
			closest = i;
		}
	}
	return closest;
}

export function parseVibeTranscript(raw: string): TranscriptSegment[] | null {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}

	if (!Array.isArray(data) || data.length === 0) {
		return null;
	}

	const segments: TranscriptSegment[] = [];
	for (const item of data) {
		if (!item || typeof item !== 'object') {
			return null;
		}
		const entry = item as Record<string, unknown>;
		const start = entry.start;
		const stop = entry.stop;
		const text = entry.text;
		if (
			typeof start !== 'number' ||
			typeof stop !== 'number' ||
			typeof text !== 'string' ||
			!Number.isFinite(start) ||
			!Number.isFinite(stop)
		) {
			return null;
		}
		segments.push({ start, stop, text });
	}

	return segments.length > 0 ? segments : null;
}

export function findSegmentIndexAt(segments: TranscriptSegment[], offsetSeconds: number): number {
	if (segments.length === 0) {
		return -1;
	}

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		if (offsetSeconds >= seg.start && offsetSeconds < seg.stop) {
			return i;
		}
	}

	let closest = 0;
	let minDist = Math.abs(segments[0].start - offsetSeconds);
	for (let i = 1; i < segments.length; i++) {
		const dist = Math.abs(segments[i].start - offsetSeconds);
		if (dist < minDist) {
			minDist = dist;
			closest = i;
		}
	}
	return closest;
}

export function findSegmentAt(
	segments: TranscriptSegment[],
	offsetSeconds: number
): { segment: TranscriptSegment; index: number } | null {
	const index = findSegmentIndexAt(segments, offsetSeconds);
	if (index < 0) {
		return null;
	}
	return { segment: segments[index], index };
}

export function serializeVibeTranscript(segments: TranscriptSegment[]): string {
	return JSON.stringify(
		segments.map((s) => ({ start: s.start, stop: s.stop, text: s.text })),
		null,
		'\t'
	);
}

export function findParagraphIndexForSegment(
	paragraphs: TranscriptParagraph[],
	segmentIndex: number
): number {
	for (let i = 0; i < paragraphs.length; i++) {
		const p = paragraphs[i];
		if (segmentIndex >= p.firstSegmentIndex && segmentIndex <= p.lastSegmentIndex) {
			return i;
		}
	}
	return -1;
}

export function formatTranscriptOffset(totalSeconds: number, showSeconds = true): string {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = Math.floor(totalSeconds % 60);

	if (hours > 0) {
		if (showSeconds) {
			return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
		}
		return `${hours}:${minutes.toString().padStart(2, '0')}`;
	}
	if (showSeconds) {
		return `${minutes}:${seconds.toString().padStart(2, '0')}`;
	}
	return `${minutes} min`;
}

export class TranscriptCache {
	private cache = new Map<string, { mtime: number; segments: TranscriptSegment[] }>();

	constructor(private app: App) {}

	invalidate(path?: string): void {
		if (path) {
			this.cache.delete(path);
		} else {
			this.cache.clear();
		}
	}

	async loadSegments(file: TFile): Promise<TranscriptSegment[] | null> {
		const cached = this.cache.get(file.path);
		if (cached && cached.mtime === file.stat.mtime) {
			return cached.segments;
		}

		const raw = await this.app.vault.read(file);
		const segments = parseVibeTranscript(raw);
		if (!segments) {
			this.cache.delete(file.path);
			return null;
		}

		this.cache.set(file.path, { mtime: file.stat.mtime, segments });
		return segments;
	}

	async isVibeTranscriptFile(file: TFile): Promise<boolean> {
		if (file.extension.toLowerCase() !== 'json') {
			return false;
		}
		const segments = await this.loadSegments(file);
		return segments !== null;
	}
}

/** Nom de base audio sans extension ; retire aussi un suffixe numérique final (ex. .53). */
export function transcriptBasenameForAudio(audioBasename: string): string {
	const dot = audioBasename.lastIndexOf('.');
	const base = dot >= 0 ? audioBasename.slice(0, dot) : audioBasename;
	return base.replace(/\.\d+$/, '');
}

export function transcriptBasenamesForAudio(audioBasename: string): string[] {
	const dot = audioBasename.lastIndexOf('.');
	const full = dot >= 0 ? audioBasename.slice(0, dot) : audioBasename;
	const trimmed = transcriptBasenameForAudio(audioBasename);
	const bases = [full];
	if (trimmed !== full) {
		bases.push(trimmed);
	}
	return bases;
}
