import { ItemView, TFile, WorkspaceLeaf } from 'obsidian';
import {
	findParagraphIndexForSegment,
	findSegmentIndexAt,
	formatTranscriptOffset,
	groupTranscriptParagraphs,
	serializeVibeTranscript,
	TranscriptParagraph,
	TranscriptSegment
} from './transcript';
import type RecordingIndicatorPlugin from './main';

export const TRANSCRIPT_VIEW_TYPE = 'universal-timestamp-transcript';

const WINDOW_RADIUS = 60;
const SAVE_DEBOUNCE_MS = 700;

export class TranscriptView extends ItemView {
	private plugin: RecordingIndicatorPlugin;
	private transcriptFile: TFile | null = null;
	private segments: TranscriptSegment[] = [];
	private paragraphs: TranscriptParagraph[] = [];
	private activeSegmentIndex = -1;
	private activeParagraphIndex = -1;
	private scrollEl: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private headerEl: HTMLElement | null = null;
	private metaEl: HTMLElement | null = null;
	private renderStart = 0;
	private renderEnd = 0;
	private saveTimer: number | null = null;
	private isSaving = false;

	constructor(leaf: WorkspaceLeaf, plugin: RecordingIndicatorPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return TRANSCRIPT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.transcriptFile?.basename ?? 'Transcription';
	}

	getIcon(): string {
		return 'file-text';
	}

	async onOpen(): Promise<void> {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('ut-transcript-view');

		this.headerEl = containerEl.createEl('div', { cls: 'ut-transcript-header' });
		this.scrollEl = containerEl.createEl('div', { cls: 'ut-transcript-scroll' });
		this.bodyEl = this.scrollEl.createEl('div', { cls: 'ut-transcript-body' });
	}

	async onClose(): Promise<void> {
		if (this.saveTimer != null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		void this.flushSave();
		this.contentEl.empty();
	}

	async openTranscript(file: TFile, offsetSeconds: number): Promise<boolean> {
		const segments = await this.plugin.transcriptCache.loadSegments(file);
		if (!segments) {
			return false;
		}

		const sameFile = this.transcriptFile?.path === file.path;
		this.transcriptFile = file;
		this.segments = segments;
		this.paragraphs = groupTranscriptParagraphs(segments);
		this.activeSegmentIndex = findSegmentIndexAt(segments, offsetSeconds);
		this.activeParagraphIndex = findParagraphIndexForSegment(
			this.paragraphs,
			this.activeSegmentIndex
		);
		this.plugin.lastTranscriptOffset = offsetSeconds;

		if (sameFile && this.bodyEl?.querySelector('.ut-transcript-chunk')) {
			this.ensureWindowContainsActiveParagraph();
			this.updateActiveHighlight();
			this.updateHeaderMeta();
			return true;
		}

		this.ensureWindowContainsActiveParagraph();
		this.render();
		return true;
	}

	private ensureWindowContainsActiveParagraph(): void {
		if (this.activeParagraphIndex < 0) {
			this.renderStart = 0;
			this.renderEnd = Math.min(WINDOW_RADIUS * 2, this.paragraphs.length);
			return;
		}
		if (this.activeParagraphIndex < this.renderStart || this.activeParagraphIndex >= this.renderEnd) {
			this.renderStart = Math.max(0, this.activeParagraphIndex - WINDOW_RADIUS);
			this.renderEnd = Math.min(
				this.paragraphs.length,
				this.activeParagraphIndex + WINDOW_RADIUS + 1
			);
		}
	}

	private updateHeaderMeta(): void {
		if (!this.metaEl) {
			return;
		}
		const offset =
			this.activeSegmentIndex >= 0 && this.activeSegmentIndex < this.segments.length
				? this.segments[this.activeSegmentIndex].start
				: 0;
		this.metaEl.setText(
			`Position : ${formatTranscriptOffset(offset, this.plugin.settings.showSeconds)} — texte modifiable, timecode au survol`
		);
	}

	private updateActiveHighlight(): void {
		if (!this.bodyEl) {
			return;
		}
		this.bodyEl.querySelectorAll('.ut-transcript-chunk-active').forEach((el) => {
			el.removeClass('ut-transcript-chunk-active');
		});
		const active = this.bodyEl.querySelector(
			`.ut-transcript-chunk[data-segment-index="${this.activeSegmentIndex}"]`
		);
		if (active) {
			active.addClass('ut-transcript-chunk-active');
			requestAnimationFrame(() => {
				active.scrollIntoView({ block: 'center', behavior: 'smooth' });
			});
		} else {
			this.render();
		}
		this.updateHeaderMeta();
	}

	private scheduleSave(): void {
		if (this.saveTimer != null) {
			window.clearTimeout(this.saveTimer);
		}
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.flushSave();
		}, SAVE_DEBOUNCE_MS);
	}

	private async flushSave(): Promise<void> {
		if (!this.transcriptFile || this.isSaving) {
			return;
		}
		this.isSaving = true;
		try {
			const content = serializeVibeTranscript(this.segments);
			await this.plugin.app.vault.modify(this.transcriptFile, content);
			this.plugin.transcriptCache.invalidate(this.transcriptFile.path);
			this.paragraphs = groupTranscriptParagraphs(this.segments);
		} finally {
			this.isSaving = false;
		}
	}

	private normalizeEditedText(segmentIndex: number, raw: string): string {
		const original = this.segments[segmentIndex].text;
		let text = raw.replace(/\s+/g, ' ').trim();
		if (!text) {
			return original.startsWith(' ') ? ' ' : '';
		}
		if (original.startsWith(' ') && !text.startsWith(' ')) {
			text = ' ' + text;
		}
		return text;
	}

	private attachChunkEditor(chunk: HTMLElement, segmentIndex: number): void {
		chunk.setAttr('contenteditable', 'true');
		chunk.setAttr('spellcheck', 'true');

		chunk.addEventListener('keydown', (ev) => {
			if (ev.key === 'Enter') {
				ev.preventDefault();
				chunk.blur();
			}
		});

		chunk.addEventListener('paste', (ev) => {
			ev.preventDefault();
			const pasted = ev.clipboardData?.getData('text/plain') ?? '';
			const clean = pasted.replace(/\s+/g, ' ').trim();
			document.execCommand('insertText', false, clean);
		});

		chunk.addEventListener('blur', () => {
			const newText = this.normalizeEditedText(segmentIndex, chunk.textContent ?? '');
			if (this.segments[segmentIndex].text !== newText) {
				this.segments[segmentIndex] = {
					...this.segments[segmentIndex],
					text: newText
				};
				this.scheduleSave();
			}
		});
	}

	private render(): void {
		if (!this.headerEl || !this.bodyEl || !this.scrollEl) {
			return;
		}

		this.headerEl.empty();
		const title = this.headerEl.createEl('div', { cls: 'ut-transcript-title' });
		title.setText(this.transcriptFile?.basename ?? 'Transcription');
		this.metaEl = this.headerEl.createEl('div', { cls: 'ut-transcript-meta' });
		this.updateHeaderMeta();

		this.bodyEl.empty();

		if (this.renderStart > 0) {
			const loadBefore = this.bodyEl.createEl('button', {
				cls: 'ut-transcript-load-more mod-muted',
				text: `↑ ${this.renderStart} paragraphes précédents`
			});
			loadBefore.onclick = () => {
				this.renderStart = Math.max(0, this.renderStart - WINDOW_RADIUS);
				this.render();
			};
		}

		const prose = this.bodyEl.createEl('div', { cls: 'ut-transcript-prose' });

		for (let i = this.renderStart; i < this.renderEnd; i++) {
			const para = this.paragraphs[i];
			const block = prose.createEl('p', {
				cls: 'ut-transcript-paragraph',
				attr: { 'data-paragraph-index': String(i) }
			});

			block.setAttr(
				'title',
				formatTranscriptOffset(para.start, this.plugin.settings.showSeconds)
			);

			const timeEl = block.createEl('span', { cls: 'ut-transcript-paragraph-time' });
			timeEl.setText(formatTranscriptOffset(para.start, this.plugin.settings.showSeconds));

			for (let segIdx = para.firstSegmentIndex; segIdx <= para.lastSegmentIndex; segIdx++) {
				const seg = this.segments[segIdx];
				const text = seg.text.trim();
				if (!text) {
					continue;
				}

				if (segIdx > para.firstSegmentIndex) {
					block.appendText(' ');
				}

				const chunk = block.createEl('span', {
					cls: 'ut-transcript-chunk',
					attr: {
						'data-segment-index': String(segIdx),
						title: formatTranscriptOffset(seg.start, this.plugin.settings.showSeconds)
					}
				});
				if (segIdx === this.activeSegmentIndex) {
					chunk.addClass('ut-transcript-chunk-active');
				}
				chunk.setText(text);
				this.attachChunkEditor(chunk, segIdx);
			}
		}

		if (this.renderEnd < this.paragraphs.length) {
			const loadAfter = this.bodyEl.createEl('button', {
				cls: 'ut-transcript-load-more mod-muted',
				text: `↓ ${this.paragraphs.length - this.renderEnd} paragraphes suivants`
			});
			loadAfter.onclick = () => {
				this.renderEnd = Math.min(this.paragraphs.length, this.renderEnd + WINDOW_RADIUS);
				this.render();
			};
		}

		requestAnimationFrame(() => {
			const active = this.bodyEl?.querySelector('.ut-transcript-chunk-active');
			active?.scrollIntoView({ block: 'center', behavior: 'smooth' });
		});
	}
}
