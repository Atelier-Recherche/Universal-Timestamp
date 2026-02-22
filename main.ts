import { Plugin, Editor, MarkdownView, Notice, TFile, App, Modal, Setting, normalizePath, CachedMetadata, setIcon, MarkdownPostProcessorContext, MarkdownRenderChild, editorLivePreviewField } from 'obsidian';
import { RecordingIndicatorSettingTab } from './settings';
import { Decoration, DecorationSet, EditorView, keymap, PluginValue, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { RangeSetBuilder, Prec } from '@codemirror/state';

interface RecordingIndicatorSettings {
	showNotifications: boolean;
	showSeconds: boolean;
	timecodeFormat: string;
	timeOffsetSeconds: number;
	timecodeAdjustmentSeconds: number;
	/** Au clic sur un timecode, déplacer la lecture dans le lecteur de la note au lieu d'ouvrir un panneau. */
	seekTimecodeInPagePlayer: boolean;
	/** Afficher dans la console les étapes du clic timecode (pour diagnostic). */
	debugTimecodeClick: boolean;
}

interface PlaceholderMatch {
	raw: string;
	json: string;
	start: number;
	end: number;
	isoTime: string;
}

const DEFAULT_SETTINGS: RecordingIndicatorSettings = {
	showNotifications: true,
	showSeconds: true,
	timecodeFormat: '[{time}]',
	timeOffsetSeconds: 0,
	timecodeAdjustmentSeconds: 10,
	seekTimecodeInPagePlayer: true,
	debugTimecodeClick: false
};

const TIMECODE_PLACEHOLDER_REGEX = /%%REC\{"time":"([^"]+)"\}%%(\[[^\]]+\]|\([^)]+\)|[^\s]+)/g;

const AUDIO_EXTENSIONS = new Set([
	'mp3',
	'wav',
	'm4a',
	'ogg',
	'webm',
	'mp4',
	'aac',
	'flac',
	'opus'
]);

class LinkRecordingModal extends Modal {
	private plugin: RecordingIndicatorPlugin;
	private onSubmit: (file: TFile, startTime: Date) => void;
	private audioFiles: TFile[];
	private selectedFile: TFile | null;
	private startTimeInputValue: string;
	private fileLocked: boolean;

	constructor(
		app: App,
		plugin: RecordingIndicatorPlugin,
		onSubmit: (file: TFile, startTime: Date) => void,
		presetFile?: TFile | null,
		fileLocked: boolean = false
	) {
		super(app);
		this.plugin = plugin;
		this.onSubmit = onSubmit;
		this.fileLocked = fileLocked;
		this.audioFiles = plugin.getAudioFiles();

		if (presetFile && !this.audioFiles.some((file) => file.path === presetFile.path)) {
			this.audioFiles.unshift(presetFile);
		}

		this.selectedFile = presetFile ?? (this.audioFiles.length > 0 ? this.audioFiles[0] : null);
		this.startTimeInputValue = this.selectedFile ? plugin.getDefaultStartTimeString(this.selectedFile) : '';
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('recording-link-modal');

		contentEl.createEl('h2', { text: 'Associer un fichier audio' });

		if (this.audioFiles.length === 0) {
			contentEl.createEl('p', {
				text: 'Aucun fichier audio détecté. Importez un enregistrement puis relancez cette commande.'
			});
			const closeButton = contentEl.createEl('button', { text: 'Fermer', cls: 'mod-cta' });
			closeButton.onclick = () => this.close();
			return;
		}

		let timeInput: import('obsidian').TextComponent;

		if (this.fileLocked && this.selectedFile) {
			// Afficher le fichier en lecture seule si verrouillé
			new Setting(contentEl)
				.setName('Fichier audio')
				.setDesc('Fichier sélectionné depuis le lecteur.')
				.addText((text) => {
					text.setValue(this.selectedFile!.basename);
					text.setDisabled(true);
				});
		} else {
			// Afficher le dropdown pour choisir le fichier
			new Setting(contentEl)
				.setName('Fichier audio')
				.setDesc('Sélectionnez l\'enregistrement à lier.')
				.addDropdown((dropdown) => {
					this.audioFiles.forEach((file) => dropdown.addOption(file.path, file.basename));
					if (this.selectedFile) {
						dropdown.setValue(this.selectedFile.path);
					}
					dropdown.onChange((value) => {
						const file = this.audioFiles.find((f) => f.path === value) ?? null;
						this.selectedFile = file;
						if (file) {
							const suggestion = this.plugin.getDefaultStartTimeString(file);
							if (suggestion) {
								this.startTimeInputValue = suggestion;
								timeInput.setValue(suggestion);
							}
						}
					});
				});
		}

		new Setting(contentEl)
			.setName('Heure de début')
			.setDesc('Format recommandé : 2025-11-07 16:32:23. Le nom du fichier est analysé automatiquement lorsque c\'est possible.')
			.addText((text) => {
				timeInput = text;
				text.setPlaceholder('YYYY-MM-DD HH:mm:ss');
				if (this.startTimeInputValue) {
					text.setValue(this.startTimeInputValue);
				}
				text.onChange((value) => (this.startTimeInputValue = value));
			});

		const buttonContainer = contentEl.createEl('div', { cls: 'modal-button-container' });

		const confirmButton = buttonContainer.createEl('button', { text: 'Associer', cls: 'mod-cta' });
		confirmButton.onclick = () => {
			if (!this.selectedFile) {
				new Notice('Veuillez sélectionner un fichier audio.');
				return;
			}
			const parsed = this.plugin.parseStartTimeInput(this.startTimeInputValue);
			if (!parsed) {
				new Notice('Heure de début invalide. Utilisez le format YYYY-MM-DD HH:mm[:ss].');
				return;
			}
			this.onSubmit(this.selectedFile, parsed);
			this.close();
		};

		const cancelButton = buttonContainer.createEl('button', { text: 'Annuler' });
		cancelButton.onclick = () => this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}

class AssociationPromptModal extends Modal {
	private file: TFile;
	private onAssociate: () => void;

	constructor(app: App, file: TFile, onAssociate: () => void) {
		super(app);
		this.file = file;
		this.onAssociate = onAssociate;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: 'Associer les horodatages ?' });
		contentEl.createEl('p', {
			text: `Un lien vers "${this.file.basename}" vient d'être inséré. Souhaitez-vous convertir les horodatages universels de cette note maintenant ?`
		});

		const buttonContainer = contentEl.createEl('div', { cls: 'modal-button-container' });
		const associateButton = buttonContainer.createEl('button', { text: 'Associer', cls: 'mod-cta' });
		associateButton.onclick = () => {
			this.close();
			this.onAssociate();
		};

		const laterButton = buttonContainer.createEl('button', { text: 'Plus tard' });
		laterButton.onclick = () => this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}

class TimecodeWidget extends MarkdownRenderChild {
	private plugin: RecordingIndicatorPlugin;
	private isoTime: string;
	private sourcePath: string;
	private adjustmentSeconds: number;

	constructor(
		containerEl: HTMLElement,
		plugin: RecordingIndicatorPlugin,
		isoTime: string,
		sourcePath: string
	) {
		super(containerEl);
		this.plugin = plugin;
		this.isoTime = isoTime;
		this.sourcePath = sourcePath;
		this.adjustmentSeconds = plugin.settings.timecodeAdjustmentSeconds;
	}

	onload() {
		const container = this.containerEl;
		container.empty();
		container.addClass('ut-timecode-widget');

		const timestamp = new Date(this.isoTime);
		if (Number.isNaN(timestamp.getTime())) {
			container.setText('[Invalid timestamp]');
			return;
		}

		const minusBtn = container.createEl('button', {
			cls: 'ut-timecode-btn',
			attr: { 'aria-label': `Retirer ${this.adjustmentSeconds}s` }
		});
		minusBtn.setText(`-${this.adjustmentSeconds}s`);
		minusBtn.addEventListener('click', () => this.adjustTime(-this.adjustmentSeconds));

		const display = container.createEl('span', { cls: 'ut-timecode-display' });
		display.setText(this.plugin.getCompactTimeLabel(timestamp));

		const plusBtn = container.createEl('button', {
			cls: 'ut-timecode-btn',
			attr: { 'aria-label': `Ajouter ${this.adjustmentSeconds}s` }
		});
		plusBtn.setText(`+${this.adjustmentSeconds}s`);
		plusBtn.addEventListener('click', () => this.adjustTime(this.adjustmentSeconds));
	}

	private async adjustTime(deltaSeconds: number) {
		const currentTime = new Date(this.isoTime);
		if (Number.isNaN(currentTime.getTime())) {
			new Notice('Impossible d\'ajuster un horodatage invalide.');
			return;
		}

		const newTime = new Date(currentTime.getTime() + deltaSeconds * 1000);
		const newIsoTime = newTime.toISOString();

		const file = this.plugin.app.vault.getAbstractFileByPath(this.sourcePath);
		if (!(file instanceof TFile)) {
			new Notice('Fichier source introuvable.');
			return;
		}

		const content = await this.plugin.app.vault.read(file);
		const oldPlaceholder = `%%REC{"time":"${this.isoTime}"}%%`;
		const newPlaceholder = `%%REC{"time":"${newIsoTime}"}%%`;

		const oldLabel = this.plugin.buildPlaceholderLabel(currentTime);
		const newLabel = this.plugin.buildPlaceholderLabel(newTime);

		const fullOldPattern = `${oldPlaceholder}${oldLabel}`;
		const fullNewPattern = `${newPlaceholder}${newLabel}`;

		if (content.includes(fullOldPattern)) {
			const newContent = content.replace(fullOldPattern, fullNewPattern);
			await this.plugin.app.vault.modify(file, newContent);
			this.isoTime = newIsoTime;

			const display = this.containerEl.querySelector('.ut-timecode-display');
			if (display) {
				display.setText(this.plugin.getCompactTimeLabel(newTime));
			}

			if (this.plugin.settings.showNotifications) {
				new Notice(`Timecode ajusté : ${newLabel}`);
			}
		} else {
			new Notice('Impossible de trouver le timecode dans le fichier.');
		}
	}
}

class TimecodeWidgetCM extends WidgetType {
	constructor(
		private plugin: RecordingIndicatorPlugin,
		private isoTime: string,
		private sourcePath: string,
		private fullMatch: string
	) {
		super();
	}

	toDOM(): HTMLElement {
		const container = document.createElement('span');
		container.addClass('ut-timecode-widget');

		const timestamp = new Date(this.isoTime);
		if (Number.isNaN(timestamp.getTime())) {
			container.setText('[Invalid timestamp]');
			return container;
		}

		const adjustmentSeconds = this.plugin.settings.timecodeAdjustmentSeconds;

		const minusBtn = container.createEl('button', {
			cls: 'ut-timecode-btn',
			attr: { 'aria-label': `Retirer ${adjustmentSeconds}s` }
		});
		minusBtn.setText(`-${adjustmentSeconds}s`);
		minusBtn.addEventListener('click', () => this.adjustTime(-adjustmentSeconds));

		const display = container.createEl('span', { cls: 'ut-timecode-display' });
		display.setText(this.plugin.getCompactTimeLabel(timestamp));

		const plusBtn = container.createEl('button', {
			cls: 'ut-timecode-btn',
			attr: { 'aria-label': `Ajouter ${adjustmentSeconds}s` }
		});
		plusBtn.setText(`+${adjustmentSeconds}s`);
		plusBtn.addEventListener('click', () => this.adjustTime(adjustmentSeconds));

		return container;
	}

	private async adjustTime(deltaSeconds: number) {
		const currentTime = new Date(this.isoTime);
		if (Number.isNaN(currentTime.getTime())) {
			new Notice('Impossible d\'ajuster un horodatage invalide.');
			return;
		}

		const newTime = new Date(currentTime.getTime() + deltaSeconds * 1000);
		const newIsoTime = newTime.toISOString();

		const file = this.plugin.app.vault.getAbstractFileByPath(this.sourcePath);
		if (!(file instanceof TFile)) {
			new Notice('Fichier source introuvable.');
			return;
		}

		const content = await this.plugin.app.vault.read(file);
		const oldPlaceholder = `%%REC{"time":"${this.isoTime}"}%%`;
		const newPlaceholder = `%%REC{"time":"${newIsoTime}"}%%`;

		const oldLabel = this.plugin.buildPlaceholderLabel(currentTime);
		const newLabel = this.plugin.buildPlaceholderLabel(newTime);

		const fullOldPattern = `${oldPlaceholder}${oldLabel}`;
		const fullNewPattern = `${newPlaceholder}${newLabel}`;

		if (content.includes(fullOldPattern)) {
			const newContent = content.replace(fullOldPattern, fullNewPattern);
			await this.plugin.app.vault.modify(file, newContent);

			if (this.plugin.settings.showNotifications) {
				new Notice(`Timecode ajusté : ${newLabel}`);
			}
		} else {
			new Notice('Impossible de trouver le timecode dans le fichier.');
		}
	}
}

class TimecodeViewPlugin implements PluginValue {
	decorations: DecorationSet;

	constructor(
		private view: EditorView,
		private plugin: RecordingIndicatorPlugin
	) {
		this.decorations = this.buildDecorations(view);
	}

	update(update: ViewUpdate) {
		if (update.docChanged || update.viewportChanged) {
			this.decorations = this.buildDecorations(update.view);
		}
	}

	destroy() {}

	buildDecorations(view: EditorView): DecorationSet {
		const builder = new RangeSetBuilder<Decoration>();

		for (const { from, to } of view.visibleRanges) {
			const text = view.state.doc.sliceString(from, to);
			let match: RegExpExecArray | null;
			const regex = new RegExp(TIMECODE_PLACEHOLDER_REGEX.source, 'g');

			while ((match = regex.exec(text)) !== null) {
				const start = from + match.index;
				const end = start + match[0].length;
				
				if (end > view.state.doc.length) {
					continue;
				}
				
				const isoTime = match[1];
				
				const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
				const sourcePath = activeView?.file?.path || '';

				const widget = Decoration.replace({
					widget: new TimecodeWidgetCM(this.plugin, isoTime, sourcePath, match[0]),
					inclusive: false
				});

				builder.add(start, end, widget);
			}
		}

		return builder.finish();
	}
}

const createTimecodeViewPlugin = (plugin: RecordingIndicatorPlugin) => {
	return ViewPlugin.fromClass(
		class extends TimecodeViewPlugin {
			constructor(view: EditorView) {
				super(view, plugin);
			}
		},
		{
			decorations: (value) => value.decorations
		}
	);
};

function tryDeleteTimecodePlaceholder(view: EditorView, isBackspace: boolean): boolean {
	const doc = view.state.doc.toString();
	const pos = view.state.selection.main.head;
	const regex = new RegExp(TIMECODE_PLACEHOLDER_REGEX.source, 'g');
	let match: RegExpExecArray | null;
	while ((match = regex.exec(doc)) !== null) {
		const start = match.index;
		const end = match.index + match[0].length;
		if (isBackspace && pos > start && pos <= end) {
			view.dispatch({ changes: { from: start, to: end }, selection: { anchor: start } });
			return true;
		}
		if (!isBackspace && pos >= start && pos < end) {
			view.dispatch({ changes: { from: start, to: end }, selection: { anchor: start } });
			return true;
		}
	}
	return false;
}

function findPlaceholderAtPos(doc: string, pos: number): { start: number; end: number } | null {
	const regex = new RegExp(TIMECODE_PLACEHOLDER_REGEX.source, 'g');
	let match: RegExpExecArray | null;
	while ((match = regex.exec(doc)) !== null) {
		const start = match.index;
		const end = match.index + match[0].length;
		if (pos >= start && pos <= end) {
			return { start, end };
		}
	}
	return null;
}

function moveCursorOverTimecode(view: EditorView, forward: boolean): boolean {
	const doc = view.state.doc.toString();
	const pos = view.state.selection.main.head;
	const placeholder = findPlaceholderAtPos(doc, pos);
	if (!placeholder) {
		return false;
	}
	const { start, end } = placeholder;
	if (forward && pos < end) {
		view.dispatch({ selection: { anchor: end } });
		return true;
	}
	if (!forward && pos > start) {
		view.dispatch({ selection: { anchor: start } });
		return true;
	}
	return false;
}

const timecodeAtomicDeleteKeymap = Prec.high(
	keymap.of([
		{ key: 'Backspace', run: (view) => tryDeleteTimecodePlaceholder(view, true) },
		{ key: 'Delete', run: (view) => tryDeleteTimecodePlaceholder(view, false) },
		{ key: 'ArrowLeft', run: (view) => moveCursorOverTimecode(view, false) },
		{ key: 'ArrowRight', run: (view) => moveCursorOverTimecode(view, true) }
	])
);

export default class RecordingIndicatorPlugin extends Plugin {
	settings: RecordingIndicatorSettings;
	private promptedAssociations = new Set<string>();
	private attachedEditors = new WeakSet<any>();
	private resourcePathCache = new Map<string, TFile>();
	private observedRoots = new WeakSet<Node>();
	private styledRoots = new WeakSet<ShadowRoot>();
	private shadowPatchApplied = false;
	private originalAttachShadow: (typeof Element.prototype.attachShadow) | null = null;
	private cacheSeeded = false;
	private modifyTimeout: NodeJS.Timeout | null = null;
	private pluginStartTime: number = Date.now();

	private handleEditorChange = (cm: any, change: any, note: TFile | null) => {
		if (!change || change.origin === 'setValue') return;
		if (!change.text || change.text.length === 0) return;

		const inserted = change.text.join('\n');
		if (!inserted || inserted.length > 300) return;

		const targets = this.extractLinkTargets(inserted, note);
		if (targets.size === 0) return;

		for (const target of targets) {
			this.handlePotentialAudioLink(note, target);
		}
	};

	async onload() {
		await this.loadSettings();
		this.pluginStartTime = Date.now();

		this.addSettingTab(new RecordingIndicatorSettingTab(this.app, this));

	this.addCommand({
		id: 'insert-universal-timestamp',
		name: 'Insérer un horodatage universel',
			editorCallback: (editor: Editor) => this.insertTimecode(editor),
			hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 't' }]
		});

		this.addCommand({
		id: 'link-recording-to-timestamps',
		name: 'Associer un fichier audio aux horodatages',
			callback: () => this.openLinkRecordingModal()
		});

		this.registerMarkdownPostProcessor((element, context) => {
			this.processTimecodeWidgets(element, context);
		});

		this.registerEditorExtension([createTimecodeViewPlugin(this), timecodeAtomicDeleteKeymap]);

		this.app.workspace.onLayoutReady(() => {
			this.attachEditorHandlers();
			// Cache lazy - ne sera rempli que quand nécessaire
			this.observeMediaPlayers();
		});
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				this.attachEditorHandlers();
				this.observeMediaPlayers();
			})
		);

		// Capture sur document pour intercepter le clic avant la navigation Obsidian
		this.registerDomEvent(document, 'click', (e: MouseEvent) => {
			this.handleTimecodeLinkClick(e);
		}, true);

		this.registerEvent(
			this.app.vault.on('create', (file) => {
				if (!(file instanceof TFile) || !this.isAudioFile(file)) {
					return;
				}

				// Ignorer les notifications pendant les 3 premières secondes après le démarrage
				// pour éviter d'afficher des notifications pour les fichiers existants
				const timeSinceStart = Date.now() - this.pluginStartTime;
				const isNewFile = timeSinceStart > 3000;

				if (isNewFile && this.settings.showNotifications) {
					new Notice(
						`Fichier audio importé : ${file.basename}. Utilisez "Associer un fichier audio aux horodatages" pour convertir vos marqueurs.`,
						4000
					);
				}
				this.cacheResourcePathForFile(file);
			})
		);
		this.registerEvent(
			this.app.vault.on('rename', (file) => {
				if (!(file instanceof TFile)) {
					return;
				}
				this.clearResourceCacheForFile(file);
				if (this.isAudioFile(file)) {
					this.cacheResourcePathForFile(file);
				}
			})
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile) {
					this.clearResourceCacheForFile(file);
				}
			})
		);
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (!(file instanceof TFile) || !this.isAudioFile(file)) {
					return;
				}
				// Debounce pour éviter les scans trop fréquents
				if (this.modifyTimeout) {
					clearTimeout(this.modifyTimeout);
				}
				this.modifyTimeout = setTimeout(() => {
					this.clearResourceCacheForFile(file);
					this.cacheResourcePathForFile(file);
					this.modifyTimeout = null;
				}, 500);
			})
		);

		// Nettoyer le timeout à la désactivation
		this.register(() => {
			if (this.modifyTimeout) {
				clearTimeout(this.modifyTimeout);
				this.modifyTimeout = null;
			}
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	getAudioFiles(): TFile[] {
		// Utiliser le cache si disponible pour éviter de scanner tous les fichiers
		if (this.cacheSeeded && this.resourcePathCache.size > 0) {
			// Si le cache est déjà rempli, on peut l'utiliser partiellement
			// Mais pour getAudioFiles(), on doit retourner tous les fichiers audio
			// donc on garde le scan complet mais seulement quand nécessaire
		}
		return this.app.vault.getFiles().filter((file) => this.isAudioFile(file));
	}

	isAudioFile(file: TFile): boolean {
		const lower = file.extension.toLowerCase();
		return AUDIO_EXTENSIONS.has(lower);
	}

	insertTimecode(editor: Editor) {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const currentFile = view?.file;

		if (currentFile) {
			const linkedAudio = this.getLinkedAudioFile(currentFile);
			
			if (linkedAudio) {
				const player = this.findPlayerForFile(linkedAudio);
				
				if (player) {
					const offsetSeconds = Math.round(player.currentTime);
					const display = this.formatOffset(offsetSeconds);
					const linkText = this.app.metadataCache.fileToLinktext(linkedAudio, currentFile.path);
					const link = `[[${linkText}#t=${offsetSeconds}|${display}]]`;
					
					editor.replaceSelection(link);
					
					if (this.settings.showNotifications) {
						new Notice(`Timecode inséré depuis le player : ${display}`);
					}
					return;
				}
			}
		}
		const now = new Date();
		const offsetDate = new Date(now.getTime() + this.settings.timeOffsetSeconds * 1000);
		const placeholder = this.buildPlaceholder(offsetDate);
		const fallback = this.buildPlaceholderLabel(offsetDate);

		editor.replaceSelection(`${placeholder}${fallback}`);

		if (this.settings.showNotifications) {
			new Notice(`Horodatage universel inséré : ${fallback}`);
		}
	}

	openLinkRecordingModal(presetFile?: TFile | null, fileLocked: boolean = false) {
		new LinkRecordingModal(
			this.app,
			this,
			(file, startTime) => {
				void this.linkRecordingToActiveNote(file, startTime);
			},
			presetFile,
			fileLocked
		).open();
	}

	async linkRecordingToActiveNote(file: TFile, startTime: Date) {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.file) {
			new Notice('Ouvrez une note Markdown pour associer un enregistrement.');
			return;
		}

		await this.app.fileManager.processFrontMatter(view.file, (frontmatter) => {
			frontmatter['audio_file'] = this.app.metadataCache.fileToLinktext(file, view.file!.path);
			frontmatter['audio_start_time'] = this.formatStartTimeForInput(startTime);
		});

		const editor = view.editor;
		const content = editor.getValue();
		const placeholders = this.collectPlaceholders(content);

		if (placeholders.length === 0) {
			new Notice('Aucun horodatage universel détecté dans la note active.');
			return;
		}

		const { replacements, skipped } = this.computeReplacements(
			placeholders,
			content,
			file,
			startTime,
			editor,
			view.file ?? null
		);
		if (replacements.length === 0) {
			new Notice('Aucun horodatage n\'a été associé. Vérifiez l\'heure de début renseignée.');
			return;
		}

		for (let i = replacements.length - 1; i >= 0; i--) {
			const replacement = replacements[i];
			editor.replaceRange(replacement.text, replacement.from, replacement.to);
		}

		if (this.settings.showNotifications) {
			new Notice(`Horodatages liés à ${file.basename} (${replacements.length} remplacement${replacements.length > 1 ? 's' : ''}).`);
			if (skipped > 0) {
				new Notice(`${skipped} horodatage${skipped > 1 ? 's' : ''} ignoré${skipped > 1 ? 's' : ''} (hors plage ou avant l'heure de début).`);
			}
		}
	}

	private collectPlaceholders(content: string): PlaceholderMatch[] {
		const results: PlaceholderMatch[] = [];
		const regex = /%%REC(\{[^%]+\})%%/g;
		let match: RegExpExecArray | null;

		while ((match = regex.exec(content)) !== null) {
			const json = match[1];
			try {
				const data = JSON.parse(json);
				if (!data || typeof data.time !== 'string') {
					continue;
				}
				results.push({
					raw: match[0],
					json,
					start: match.index,
					end: match.index + match[0].length,
					isoTime: data.time
				});
			} catch {
				continue;
			}
		}

		return results;
	}

	private computeReplacements(
		matches: PlaceholderMatch[],
		content: string,
		file: TFile,
		startTime: Date,
		editor: Editor,
		currentNote: TFile | null
	) {
		const replacements: { from: any; to: any; text: string }[] = [];
		let skipped = 0;

		for (const placeholder of matches) {
			const timestamp = new Date(placeholder.isoTime);
			if (Number.isNaN(timestamp.getTime())) {
				skipped++;
				continue;
			}

			const offsetSeconds = Math.round((timestamp.getTime() - startTime.getTime()) / 1000);
			if (offsetSeconds < 0 || offsetSeconds > 24 * 3600) {
				skipped++;
				continue;
			}

			const display = this.formatOffset(offsetSeconds);
			const linkText = currentNote
				? this.app.metadataCache.fileToLinktext(file, currentNote.path)
				: file.basename;
			const replacement = `[[${linkText}#t=${offsetSeconds}|${display}]]`;

			let replacementEnd = placeholder.end;
			const fallback = this.buildPlaceholderLabel(timestamp);
			const remainder = content.slice(placeholder.end);
			const fallbackPattern = new RegExp(`^\\s*${escapeRegExp(fallback)}`);
			const fallbackMatch = remainder.match(fallbackPattern);
			if (fallbackMatch) {
				replacementEnd += fallbackMatch[0].length;
			}

			const from = editor.offsetToPos(placeholder.start);
			const to = editor.offsetToPos(replacementEnd);

			replacements.push({ from, to, text: replacement });
		}

		return { replacements, skipped };
	}

	private buildPlaceholder(date: Date): string {
		const payload = JSON.stringify({ time: date.toISOString() });
		return `%%REC${payload}%%`;
	}

	buildPlaceholderLabel(date: Date): string {
		const formatted = this.formatAbsoluteTime(date);
		return this.settings.timecodeFormat.replace('{time}', formatted);
	}

	getCompactTimeLabel(date: Date): string {
		const label = this.buildPlaceholderLabel(date);
		return label.replace(/^[\[(]|[)\]]$/g, '');
	}

	private formatAbsoluteTime(date: Date): string {
		const hours = date.getHours().toString().padStart(2, '0');
		const minutes = date.getMinutes().toString().padStart(2, '0');
		if (!this.settings.showSeconds) {
			return `${hours}:${minutes}`;
		}
		const seconds = date.getSeconds().toString().padStart(2, '0');
		return `${hours}:${minutes}:${seconds}`;
	}

	private formatOffset(totalSeconds: number): string {
		const hours = Math.floor(totalSeconds / 3600);
		const minutes = Math.floor((totalSeconds % 3600) / 60);
		const seconds = totalSeconds % 60;

		if (this.settings.showSeconds) {
			if (hours > 0) {
				return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds
					.toString()
					.padStart(2, '0')}`;
			}
			return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
		}

		if (hours > 0) {
			return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
		}

		return `${minutes.toString()}min`;
	}

	getDefaultStartTimeString(file: TFile): string {
		const parsed = this.parseDateFromFileName(file.basename);
		return parsed ? this.formatStartTimeForInput(parsed) : '';
	}

	parseDateFromFileName(baseName: string): Date | null {
		const normalized = baseName.replace(/[_]/g, ' ').replace(/[\.]/g, ':');
		const pattern = /(\d{4})[- ]?(\d{2})[- ]?(\d{2})[ T]?(\d{2}):?(\d{2})(?::(\d{2}))?/;
		const match = normalized.match(pattern);
		if (!match) {
			return null;
		}
		return this.buildDate(match[1], match[2], match[3], match[4], match[5], match[6]);
	}

	parseStartTimeInput(input: string): Date | null {
		if (!input) return null;
		let normalized = input.trim();
		if (!normalized) return null;

		normalized = normalized.replace(/[_T]/g, ' ').replace(/\./g, ':');

		let match = normalized.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
		if (match) {
			return this.buildDate(match[1], match[2], match[3], match[4], match[5], match[6]);
		}

		match = normalized.match(/(\d{4})(\d{2})(\d{2})\s+(\d{2})(\d{2})(\d{2})/);
		if (match) {
			return this.buildDate(match[1], match[2], match[3], match[4], match[5], match[6]);
		}

		match = normalized.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
		if (match) {
			return this.buildDate(match[1], match[2], match[3], match[4], match[5], '0');
		}

		return null;
	}

	private buildDate(year: string, month: string, day: string, hour: string, minute: string, second?: string): Date | null {
		const date = new Date(
			Number(year),
			Number(month) - 1,
			Number(day),
			Number(hour),
			Number(minute),
			second ? Number(second) : 0
		);
		return Number.isNaN(date.getTime()) ? null : date;
	}

	formatStartTimeForInput(date: Date): string {
		const year = date.getFullYear().toString().padStart(4, '0');
		const month = (date.getMonth() + 1).toString().padStart(2, '0');
		const day = date.getDate().toString().padStart(2, '0');
		const hours = date.getHours().toString().padStart(2, '0');
		const minutes = date.getMinutes().toString().padStart(2, '0');
		const seconds = date.getSeconds().toString().padStart(2, '0');

		return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
	}

	private attachEditorHandlers(view?: MarkdownView | null) {
		const targetView = view ?? this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!targetView) return;

		const editorAny = targetView.editor as any;
		if (!editorAny || typeof editorAny.on !== 'function') return;

		if (this.attachedEditors.has(editorAny)) {
			return;
		}
		this.attachedEditors.add(editorAny);

		const handler = (instance: any, change: any) => {
			this.handleEditorChange(instance, change, targetView.file ?? null);
		};

		editorAny.on('change', handler);
		this.register(() => {
			editorAny.off?.('change', handler);
			this.attachedEditors.delete(editorAny);
		});
	}

	private handlePotentialAudioLink(note: TFile | null, linkTarget: string | null) {
		if (!note || !linkTarget) {
			return;
		}

		const resolved = this.resolveFileFromLink(linkTarget, note);
		if (resolved && this.isAudioFile(resolved)) {
			this.promptAssociationForFile(note, resolved);
		}
	}

	private promptAssociationForFile(note: TFile, file: TFile) {
		const key = `${note.path}::${file.path}`;
		if (this.promptedAssociations.has(key)) {
			return;
		}
		this.promptedAssociations.add(key);
		new AssociationPromptModal(this.app, file, () => {
			this.openLinkRecordingModal(file);
		}).open();
	}


	private resolveFileFromLink(linkTarget: string, source: TFile): TFile | null {
		const cleaned = this.sanitiseLinkPath(linkTarget);
		if (!cleaned) {
			return null;
		}

		const resolved = this.app.metadataCache.getFirstLinkpathDest(cleaned, source.path);
		if (resolved instanceof TFile) {
			return resolved;
		}

		const normalized = this.normalizeRelativePath(cleaned, source);
		if (!normalized) {
			return null;
		}

		const abstract = this.app.vault.getAbstractFileByPath(normalized);
		return abstract instanceof TFile ? abstract : null;
	}

	private normalizeRelativePath(target: string, source: TFile): string | null {
		const cleaned = target.replace(/\\/g, '/');
		if (!cleaned) {
			return null;
		}

		if (cleaned.startsWith('/')) {
			return normalizePath(cleaned);
		}

		const sourceParts = source.path.split('/');
		sourceParts.pop();
		const base = sourceParts.join('/');
		const combined = base ? `${base}/${cleaned}` : cleaned;
		return normalizePath(combined);
	}

	private sanitiseLinkPath(input: string): string {
		return input.split('#')[0]?.trim() ?? '';
	}

	/**
	 * Retourne la MarkdownView dont le conteneur contient l'élément (pour savoir dans quelle note le lien a été cliqué).
	 */
	private getMarkdownViewContaining(el: HTMLElement): MarkdownView | null {
		let found: MarkdownView | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.contentEl?.contains(el)) {
				found = view;
				return false; // arrêter l’itération
			}
			return true;
		});
		return found;
	}

	/**
	 * Extrait le chemin vault (pour getFirstLinkpathDest) depuis un href Obsidian (ex. app://local/dossier/fichier.m4a).
	 */
	private linkPathFromHref(href: string): string {
		let path = href.trim().replace(/\\/g, '/');
		// Obsidian rend souvent les liens en app://local/chemin/relatif/au/vault
		if (path.startsWith('app://local/')) {
			path = path.slice('app://local/'.length);
		} else if (path.startsWith('app://')) {
			const after = path.slice(6);
			const slash = after.indexOf('/');
			path = slash >= 0 ? after.slice(slash + 1) : after;
		}
		// Parfois le chemin commence par le nom du vault ; les chemins internes sont relatifs à la racine
		const vaultName = this.app.vault.getName();
		if (vaultName && path.startsWith(vaultName + '/')) {
			path = path.slice(vaultName.length + 1);
		}
		return path;
	}

	/**
	 * Au clic sur un lien timecode (#t=…), si l'option est activée et que la note contient
	 * le lecteur pour ce fichier audio, on positionne la lecture dans ce lecteur au lieu d'ouvrir un panneau.
	 */
	private handleTimecodeLinkClick(e: MouseEvent): void {
		const dbg = this.settings.debugTimecodeClick;
		if (!this.settings.seekTimecodeInPagePlayer || e.button !== 0) {
			return;
		}

		const target = e.target as HTMLElement;
		const inEditor = target?.closest?.('.cm-editor');
		const inPreview = target?.closest?.('.markdown-preview-view');
		if (dbg && (inEditor || inPreview)) {
			console.log('[Universal Timestamp] Clic dans la note', {
				tag: target?.tagName,
				class: target?.className?.slice?.(0, 80),
				inEditor: !!inEditor,
				inPreview: !!inPreview
			});
		}

		// 1) Lien rendu (preview) : <a> ou élément avec data-href
		let link: HTMLElement | null = target?.closest?.('a[href*="#t="], a[data-href*="#t="]');
		if (!link) {
			link = target?.closest?.('[data-href*="#t="]');
		}
		if (link && (link instanceof HTMLAnchorElement || link.getAttribute('data-href'))) {
			this.handleTimecodeHref(link.getAttribute('data-href') ?? (link as HTMLAnchorElement).getAttribute?.('href') ?? '', link, dbg, e);
			return;
		}

		// 2) Clic dans l’éditeur (Live Preview / source) : récupérer le lien à la position du clic
		if (inEditor) {
			const fromEditor = this.handleTimecodeClickInEditor(e, dbg);
			if (fromEditor) {
				e.preventDefault();
				e.stopPropagation();
				e.stopImmediatePropagation();
			}
			return;
		}

		if (dbg && inPreview) {
			console.log('[Universal Timestamp] Preview : pas de lien #t= trouvé sur', target?.tagName);
		}
	}

	private handleTimecodeHref(href: string, link: HTMLElement, dbg: boolean, e: MouseEvent): void {
		if (!href.includes('#t=')) {
			if (dbg) console.log('[Universal Timestamp] Lien sans #t=', href);
			return;
		}

		const sharpIndex = href.indexOf('#');
		const pathRaw = sharpIndex >= 0 ? href.slice(0, sharpIndex).trim() : '';
		const hash = sharpIndex >= 0 ? href.slice(sharpIndex + 1).trim() : '';
		const tMatch = hash.match(/^t=(\d+)$/);
		if (!pathRaw || !tMatch) {
			if (dbg) console.log('[Universal Timestamp] Hash invalide', pathRaw, hash);
			return;
		}

		const path = this.linkPathFromHref(pathRaw);
		if (!path) {
			if (dbg) console.log('[Universal Timestamp] Chemin vide après parse', pathRaw);
			return;
		}

		const offsetSeconds = parseInt(tMatch[1], 10);
		if (!Number.isFinite(offsetSeconds) || offsetSeconds < 0) {
			return;
		}

		if (dbg) console.log('[Universal Timestamp] Lien timecode détecté', { path, pathRaw, offsetSeconds, href });

		const view = this.getMarkdownViewContaining(link) ?? this.app.workspace.getActiveViewOfType(MarkdownView);
		if (this.trySeekToTimecode(view, path, offsetSeconds, dbg)) {
			e.preventDefault();
			e.stopPropagation();
			e.stopImmediatePropagation();
		}
	}

	/**
	 * Positionne la lecture du lecteur de la note à offsetSeconds. Retourne true si le seek a été fait.
	 */
	private trySeekToTimecode(view: MarkdownView | null, path: string, offsetSeconds: number, dbg: boolean): boolean {
		if (!view?.file) {
			if (dbg) console.log('[Universal Timestamp] Pas de vue Markdown ou fichier');
			return false;
		}
		const resolved = this.resolveFileFromLink(path, view.file);
		if (!resolved || !this.isAudioFile(resolved)) {
			if (dbg) console.log('[Universal Timestamp] Fichier non résolu ou pas audio', path, resolved?.path);
			return false;
		}
		const linkedAudio = this.getLinkedAudioFile(view.file);
		if (linkedAudio?.path !== resolved.path) {
			if (dbg) console.log('[Universal Timestamp] Audio lié à la note différent du lien', linkedAudio?.path, resolved.path);
			return false;
		}
		let player = this.findPlayerForFile(resolved);
		if (!player && view.contentEl) {
			player = this.findPlayerInContainer(view.contentEl, resolved);
		}
		if (!player) {
			if (dbg) console.log('[Universal Timestamp] Aucun lecteur trouvé pour', resolved.path);
			return false;
		}
		player.currentTime = offsetSeconds;
		player.play().catch(() => {});
		if (dbg) console.log('[Universal Timestamp] Lecture positionnée à', offsetSeconds, 's');
		return true;
	}

	/**
	 * Clic dans l’éditeur (Live Preview ou source) : trouve le lien [[...#t=...]] à la position du clic et lance le seek.
	 */
	private handleTimecodeClickInEditor(e: MouseEvent, dbg: boolean): boolean {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file?.extension?.toLowerCase?.()?.endsWith?.('md') || !view.editor) {
			return false;
		}
		const editor = view.editor as {
			cm?: { posAtCoords?: (p: { x: number; y: number }) => { pos: number } | null };
			posAtMouse?: (ev: MouseEvent) => { line: number; ch: number } | null;
			getValue?: () => string;
		};
		let offset: number | null = null;
		const posAtMouse = editor.posAtMouse?.(e);
		if (posAtMouse != null && typeof posAtMouse.line === 'number') {
			const content = view.editor.getValue();
			const lines = content.split('\n');
			for (let i = 0; i < posAtMouse.line && i < lines.length; i++) {
				offset = (offset ?? 0) + lines[i].length + 1;
			}
			offset = (offset ?? 0) + posAtMouse.ch;
		}
		if (offset == null && editor.cm?.posAtCoords) {
			const posResult = editor.cm.posAtCoords({ x: e.clientX, y: e.clientY });
			if (posResult?.pos != null) offset = posResult.pos;
		}
		if (offset == null || offset < 0) {
			if (dbg) console.log('[Universal Timestamp] Éditeur : position non trouvée au clic');
			return false;
		}
		const content = view.editor.getValue();
		// Trouver tous les liens wiki [[path#t=123|label]] ou [[path#t=123]]
		// Lien wiki [[path#t=123|label]] ou [[path#t=123]] — [^\]#] = pas ] ni # ; label optionnel sans ]
		const wikiLinkRegex = /\[\[([^\]#]+)#t=(\d+)(?:\|[^\x5D]*)?\]\]/g;
		let match: RegExpExecArray | null;
		while ((match = wikiLinkRegex.exec(content)) !== null) {
			const start = match.index;
			const end = start + match[0].length;
			if (offset >= start && offset <= end) {
				const fullMatch = match[1].trim(); // "path/to/file.opus#t=123"
				const sharpIdx = fullMatch.indexOf('#');
				const path = sharpIdx >= 0 ? fullMatch.slice(0, sharpIdx).trim() : fullMatch;
				const offsetSeconds = parseInt(match[2], 10);
				if (!path || !Number.isFinite(offsetSeconds) || offsetSeconds < 0) continue;
				if (dbg) console.log('[Universal Timestamp] Éditeur : lien timecode à la position', { path, offsetSeconds });
				return this.trySeekToTimecode(view, path, offsetSeconds, dbg);
			}
		}
		if (dbg) console.log('[Universal Timestamp] Éditeur : pas de lien #t= à la position', offset);
		return false;
	}

	private sanitiseMarkdownLinkTarget(input: string): string {
		let cleaned = input.trim();
		if (cleaned.startsWith('<') && cleaned.endsWith('>')) {
			cleaned = cleaned.slice(1, -1);
		}
		cleaned = cleaned.replace(/^['"]/, '').replace(/['"]$/, '');
		try {
			cleaned = decodeURI(cleaned);
		} catch {
			// ignore decoding errors
		}
		return cleaned;
	}

	private extractExtension(path: string): string | null {
		const match = path.match(/\.([a-z0-9]+)$/i);
		return match ? match[1].toLowerCase() : null;
	}

	private extractLinkTargets(text: string, note: TFile | null): Set<string> {
		const results = new Set<string>();

		const wikiMatches = text.matchAll(/!?\[\[([^\]]+)\]\]/g);
		for (const match of wikiMatches) {
			const target = match[1];
			const [linkTarget] = target.split('|');
			if (linkTarget) {
				results.add(linkTarget);
			}
		}

		const markdownMatches = text.matchAll(/!?\[[^\]]*?\]\(([^)]+)\)/g);
		for (const match of markdownMatches) {
			const rawTarget = match[1];
			const sanitized = this.sanitiseMarkdownLinkTarget(rawTarget);
			if (sanitized) {
				results.add(sanitized);
			}
		}

		if (note) {
			const metadata = this.app.metadataCache.getFileCache(note);
			this.addFrontmatterEmbeddedFiles(metadata, results);
		}

		return results;
	}

	private addFrontmatterEmbeddedFiles(metadata: CachedMetadata | null | undefined, results: Set<string>) {
		if (!metadata?.frontmatter) {
			return;
		}

		const processValue = (value: unknown) => {
			if (typeof value === 'string') {
				results.add(value);
			} else if (Array.isArray(value)) {
				value.forEach(processValue);
			} else if (value && typeof value === 'object') {
				Object.values(value).forEach(processValue);
			}
		};

		Object.values(metadata.frontmatter).forEach(processValue);
	}

	private observeMediaPlayers() {
		if (typeof document === 'undefined' || !document.body) {
			return;
		}

		// Éviter les appels multiples
		if (this.observedRoots.has(document)) {
			return;
		}

		this.patchAttachShadow();
		this.observeRoot(document);
		this.observeExistingShadowHosts();
	}

	private observeRoot(root: Document | ShadowRoot) {
		if (this.observedRoots.has(root)) {
			this.decoratePlayersIn(root);
			return;
		}

		this.observedRoots.add(root);
		this.injectStylesIntoRoot(root);

		const observer = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				mutation.addedNodes.forEach((node) => {
					if (node instanceof HTMLElement) {
						if (node.matches('[data-media-player]')) {
							this.decorateMediaPlayer(node);
						}

						if (node.shadowRoot) {
							this.observeRoot(node.shadowRoot);
						}

						node.querySelectorAll<HTMLElement>('[data-media-player]').forEach((child) =>
							this.decorateMediaPlayer(child)
						);

						node.querySelectorAll<HTMLElement>('.mx-player-shadow-root').forEach((host) => {
							if (host.shadowRoot) {
								this.observeRoot(host.shadowRoot);
							}
						});
					} else if (node instanceof DocumentFragment) {
						node.querySelectorAll<HTMLElement>('[data-media-player]').forEach((child) =>
							this.decorateMediaPlayer(child)
						);

						node.querySelectorAll<HTMLElement>('.mx-player-shadow-root').forEach((host) => {
							if (host.shadowRoot) {
								this.observeRoot(host.shadowRoot);
							}
						});
					}
				});
			}
		});

		observer.observe(root, { childList: true, subtree: true });
		this.register(() => observer.disconnect());

		this.decoratePlayersIn(root);
	}

	private observeExistingShadowHosts() {
		document
			.querySelectorAll<HTMLElement>('.mx-player-shadow-root')
			.forEach((host) => host.shadowRoot && this.observeRoot(host.shadowRoot));
	}

	private decoratePlayersIn(root: Document | ShadowRoot) {
		root.querySelectorAll<HTMLElement>('[data-media-player]').forEach((player) => this.decorateMediaPlayer(player));
	}

	private patchAttachShadow() {
		if (this.shadowPatchApplied) {
			return;
		}

		const original = Element.prototype.attachShadow;
		if (!original) {
			return;
		}

		const plugin = this;
		this.originalAttachShadow = original;

		Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit): ShadowRoot {
			const shadow = original.call(this, init);
			plugin.observeRoot(shadow);
			return shadow;
		};

		this.shadowPatchApplied = true;

		this.register(() => {
			if (this.shadowPatchApplied && this.originalAttachShadow) {
				Element.prototype.attachShadow = this.originalAttachShadow;
				this.shadowPatchApplied = false;
				this.originalAttachShadow = null;
			}
		});
	}

	private injectStylesIntoRoot(root: Document | ShadowRoot) {
		if (!(root instanceof ShadowRoot)) {
			return;
		}

		if (this.styledRoots.has(root)) {
			return;
		}

		const style = document.createElement('style');
		style.textContent = `
			:host, :root {
				--ut-associate-button-size: 32px;
			}
			.ut-player-enhanced {
				position: relative;
			}
			.ut-associate-container {
				position: absolute;
				top: 8px;
				right: 8px;
				display: flex;
				pointer-events: auto;
				z-index: 40;
			}
			.ut-associate-button {
				display: inline-flex;
				align-items: center;
				justify-content: center;
				width: var(--ut-associate-button-size);
				height: var(--ut-associate-button-size);
				border-radius: 999px;
				border: none;
				background-color: var(--interactive-accent);
				color: var(--text-on-accent);
				cursor: pointer;
				box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
				transition: transform 0.15s ease, box-shadow 0.15s ease, background-color 0.15s ease;
				padding: 0;
			}
			.ut-associate-button:hover {
				transform: translateY(-1px);
				box-shadow: 0 3px 10px rgba(0, 0, 0, 0.2);
				background-color: var(--interactive-accent-hover, var(--interactive-accent));
			}
			.ut-associate-button:focus-visible {
				outline: 2px solid var(--text-on-accent);
				outline-offset: 2px;
			}
			.ut-associate-icon svg {
				width: 16px;
				height: 16px;
			}
		`;

		root.appendChild(style);
		this.styledRoots.add(root);

		this.register(() => {
			style.remove();
		});
	}

	private seedResourcePathCache() {
		if (this.cacheSeeded) {
			return;
		}
		this.cacheSeeded = true;
		// Limiter le scan initial - ne cacher que les premiers fichiers
		const audioFiles = this.getAudioFiles();
		// Ne cacher que les 50 premiers fichiers pour éviter un scan complet au démarrage
		audioFiles.slice(0, 50).forEach((file) => this.cacheResourcePathForFile(file));
	}

	private decorateMediaPlayer(player: HTMLElement) {
		if (!player || player.dataset.utEnhanced === 'true') {
			return;
		}

		const computed = window.getComputedStyle(player);
		const adjustPosition = !player.style.position && computed?.position === 'static';
		if (adjustPosition) {
			player.dataset.utPositionAdjusted = 'true';
			player.style.position = 'relative';
		}

		player.dataset.utEnhanced = 'true';
		player.classList.add('ut-player-enhanced');

		const container = document.createElement('div');
		container.classList.add('ut-associate-container');
		container.style.position = 'absolute';
		container.style.top = '8px';
		container.style.left = '8px';
		container.style.display = 'flex';
		container.style.pointerEvents = 'auto';
		container.style.zIndex = '40';

		const button = document.createElement('button');
		button.type = 'button';
		button.classList.add('ut-associate-button');
		button.setAttribute('aria-label', 'Associer les horodatages');
		button.setAttribute('title', 'Associer les horodatages');
		button.style.display = 'inline-flex';
		button.style.alignItems = 'center';
		button.style.justifyContent = 'center';
		button.style.width = '32px';
		button.style.height = '32px';
		button.style.borderRadius = '999px';
		button.style.border = 'none';
		button.style.backgroundColor = 'var(--interactive-accent)';
		button.style.color = 'var(--text-on-accent)';
		button.style.cursor = 'pointer';
		button.style.boxShadow = '0 2px 6px rgba(0, 0, 0, 0.15)';
		button.style.transition = 'transform 0.15s ease, box-shadow 0.15s ease, background-color 0.15s ease';
		button.style.padding = '0';
		button.style.pointerEvents = 'auto';

		button.addEventListener('mouseenter', () => {
			button.style.transform = 'translateY(-1px)';
			button.style.boxShadow = '0 3px 10px rgba(0, 0, 0, 0.2)';
		});
		button.addEventListener('mouseleave', () => {
			button.style.transform = '';
			button.style.boxShadow = '0 2px 6px rgba(0, 0, 0, 0.15)';
		});

		const iconSpan = document.createElement('span');
		iconSpan.classList.add('ut-associate-icon');
		iconSpan.style.display = 'flex';
		iconSpan.style.alignItems = 'center';
		iconSpan.style.justifyContent = 'center';
		setIcon(iconSpan, 'link');
		button.appendChild(iconSpan);

		button.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			const file = this.findFileForPlayer(player);
			if (!file) {
				new Notice('Impossible de retrouver le fichier audio lié.');
				return;
			}
			// Verrouiller le fichier quand on clique depuis le bouton du lecteur
			this.openLinkRecordingModal(file, true);
		});

		container.appendChild(button);
		player.appendChild(container);

		this.register(() => {
			if (container.isConnected) {
				container.remove();
			}
			if (player.dataset.utPositionAdjusted === 'true') {
				player.style.position = '';
				delete player.dataset.utPositionAdjusted;
			}
			delete player.dataset.utEnhanced;
		});
	}

	private findFileForPlayer(player: HTMLElement): TFile | null {
		const media = player.querySelector('audio, video') as HTMLMediaElement | null;
		if (!media) {
			return null;
		}

		const candidates = new Set<string>();
		if (media.currentSrc) {
			candidates.add(media.currentSrc);
		}
		if (media.src) {
			candidates.add(media.src);
		}
		media.querySelectorAll('source').forEach((source) => {
			if (source instanceof HTMLSourceElement && source.src) {
				candidates.add(source.src);
			}
		});

		for (const candidate of candidates) {
			const file = this.getFileFromResourcePath(candidate);
			if (file) {
				return file;
			}
		}

		return null;
	}

	private getFileFromResourcePath(resourcePath: string): TFile | null {
		if (!resourcePath) {
			return null;
		}

		const cached = this.resourcePathCache.get(resourcePath);
		if (cached) {
			return cached;
		}

		const resourceWithoutQuery = resourcePath.split('?')[0] ?? resourcePath;
		const cachedWithoutQuery = this.resourcePathCache.get(resourceWithoutQuery);
		if (cachedWithoutQuery) {
			this.resourcePathCache.set(resourcePath, cachedWithoutQuery);
			return cachedWithoutQuery;
		}

		// Seed le cache si nécessaire (lazy loading)
		this.seedResourcePathCache();

		// Chercher dans le cache d'abord
		for (const [cachedPath, file] of this.resourcePathCache.entries()) {
			const baseCached = cachedPath.split('?')[0] ?? cachedPath;
			if (cachedPath === resourcePath || baseCached === resourceWithoutQuery) {
				this.resourcePathCache.set(resourcePath, file);
				this.resourcePathCache.set(resourceWithoutQuery, file);
				return file;
			}
		}

		// Si pas trouvé dans le cache, chercher dans tous les fichiers (mais seulement si nécessaire)
		for (const file of this.getAudioFiles()) {
			const adapterResource = this.getAdapterResourcePath(file);
			if (!adapterResource) {
				continue;
			}

			const baseResource = adapterResource.split('?')[0] ?? adapterResource;
			this.resourcePathCache.set(adapterResource, file);
			this.resourcePathCache.set(baseResource, file);

			if (adapterResource === resourcePath || baseResource === resourceWithoutQuery) {
				this.resourcePathCache.set(resourcePath, file);
				this.resourcePathCache.set(resourceWithoutQuery, file);
				return file;
			}
		}

		return null;
	}

	private cacheResourcePathForFile(file: TFile) {
		const resource = this.getAdapterResourcePath(file);
		if (!resource) {
			return;
		}
		const base = resource.split('?')[0] ?? resource;
		this.resourcePathCache.set(resource, file);
		this.resourcePathCache.set(base, file);
	}

	private clearResourceCacheForFile(file: TFile) {
		for (const [key, cachedFile] of this.resourcePathCache.entries()) {
			if (cachedFile === file || cachedFile.path === file.path) {
				this.resourcePathCache.delete(key);
			}
		}
	}

	private getAdapterResourcePath(file: TFile): string | null {
		const adapter = this.app.vault.adapter as { getResourcePath?: (path: string) => string };
		if (!adapter?.getResourcePath) {
			return null;
		}
		try {
			return adapter.getResourcePath(file.path);
		} catch {
			return null;
		}
	}

	private getLinkedAudioFile(note: TFile): TFile | null {
		const metadata = this.app.metadataCache.getFileCache(note);
		
		if (metadata?.frontmatter?.audio_file) {
			const audioLink = metadata.frontmatter.audio_file;
			const resolved = this.resolveFileFromLink(audioLink, note);
			if (resolved && this.isAudioFile(resolved)) {
				return resolved;
			}
		}

		if (metadata?.links) {
			for (const link of metadata.links) {
				const resolved = this.resolveFileFromLink(link.link, note);
				if (resolved && this.isAudioFile(resolved)) {
					return resolved;
				}
			}
		}

		if (metadata?.embeds) {
			for (const embed of metadata.embeds) {
				const resolved = this.resolveFileFromLink(embed.link, note);
				if (resolved && this.isAudioFile(resolved)) {
					return resolved;
				}
			}
		}

		return null;
	}

	private findPlayerForFile(file: TFile): HTMLMediaElement | null {
		const resourcePath = this.getAdapterResourcePath(file);
		if (!resourcePath) {
			return null;
		}

		const baseResourcePath = resourcePath.split('?')[0];

		const allMediaElements: HTMLMediaElement[] = [];
		
		const collectMedia = (root: Document | ShadowRoot) => {
			root.querySelectorAll<HTMLMediaElement>('audio, video').forEach(el => allMediaElements.push(el));
			
			root.querySelectorAll('*').forEach(el => {
				if (el.shadowRoot) {
					collectMedia(el.shadowRoot);
				}
			});
		};
		
		collectMedia(document);
		
		for (const media of allMediaElements) {
			const candidates = new Set<string>();
			
			if (media.currentSrc) {
				candidates.add(media.currentSrc);
			}
			if (media.src) {
				candidates.add(media.src);
			}
			
			media.querySelectorAll('source').forEach((source) => {
				if (source instanceof HTMLSourceElement && source.src) {
					candidates.add(source.src);
				}
			});

			for (const candidate of candidates) {
				const baseCandidate = candidate.split('?')[0];
				if (candidate === resourcePath || baseCandidate === baseResourcePath) {
					return media;
				}
			}
		}
		
		const fileName = file.basename;
		for (const media of allMediaElements) {
			const src = media.currentSrc || media.src;
			if (src && src.includes(encodeURIComponent(fileName))) {
				return media;
			}
		}

		return null;
	}

	/**
	 * Cherche un lecteur audio/vidéo dans un conteneur (ex. contenu d'une vue), pour un fichier donné.
	 * Utile quand le lecteur a une URL non reconnue (ex. Media Extended avec app://).
	 */
	private findPlayerInContainer(container: HTMLElement, file: TFile): HTMLMediaElement | null {
		const all: HTMLMediaElement[] = [];
		const collect = (root: Document | ShadowRoot | HTMLElement) => {
			root.querySelectorAll<HTMLMediaElement>('audio, video').forEach((el) => all.push(el));
			root.querySelectorAll('*').forEach((el) => {
				if (el.shadowRoot) collect(el.shadowRoot);
			});
		};
		collect(container);

		const resourcePath = this.getAdapterResourcePath(file);
		const baseResource = resourcePath?.split('?')[0];
		const fileName = file.basename;

		for (const media of all) {
			const candidates = new Set<string>();
			if (media.currentSrc) candidates.add(media.currentSrc);
			if (media.src) candidates.add(media.src);
			media.querySelectorAll('source').forEach((s) => {
				if (s instanceof HTMLSourceElement && s.src) candidates.add(s.src);
			});
			for (const src of candidates) {
				const base = src.split('?')[0];
				if (resourcePath && (src === resourcePath || base === baseResource)) return media;
				try {
					if (fileName && decodeURIComponent(src).includes(fileName)) return media;
				} catch { /* ignore */ }
			}
		}
		// Une seule piste dans la vue et c'est la bonne note → on la prend
		if (all.length === 1) return all[0];
		return null;
	}

	private getStartTimeForFile(file: TFile): Date | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file) {
			return null;
		}

		const metadata = this.app.metadataCache.getFileCache(view.file);
		
		if (metadata?.frontmatter?.audio_start_time) {
			const parsed = this.parseStartTimeInput(metadata.frontmatter.audio_start_time);
			if (parsed) {
				return parsed;
			}
		}

		const parsedFromFilename = this.parseDateFromFileName(file.basename);
		if (parsedFromFilename) {
			return parsedFromFilename;
		}

		return null;
	}

	private processTimecodeWidgets(element: HTMLElement, context: MarkdownPostProcessorContext) {
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);
		const nodesToProcess: { node: Text; matches: RegExpMatchArray[] }[] = [];

		let node: Node | null;
		while ((node = walker.nextNode())) {
			if (node.nodeType === Node.TEXT_NODE && node.textContent) {
				const text = node.textContent;
				const regex = /%%REC\{"time":"([^"]+)"\}%%(\[[^\]]+\]|\([^)]+\)|[^\s]+)/g;
				const matches = Array.from(text.matchAll(regex));
				if (matches.length > 0) {
					nodesToProcess.push({ node: node as Text, matches });
				}
			}
		}

		for (const { node, matches } of nodesToProcess) {
			const text = node.textContent!;
			const fragments: (string | HTMLElement)[] = [];
			let lastIndex = 0;

			for (const match of matches) {
				const matchStart = match.index!;
				const matchEnd = matchStart + match[0].length;

				if (matchStart > lastIndex) {
					fragments.push(text.substring(lastIndex, matchStart));
				}

				const widgetContainer = document.createElement('span');
				const widget = new TimecodeWidget(
					widgetContainer,
					this,
					match[1],
					context.sourcePath
				);
				context.addChild(widget);
				fragments.push(widgetContainer);

				lastIndex = matchEnd;
			}

			if (lastIndex < text.length) {
				fragments.push(text.substring(lastIndex));
			}

			const parent = node.parentNode;
			if (parent) {
				for (const fragment of fragments) {
					if (typeof fragment === 'string') {
						parent.insertBefore(document.createTextNode(fragment), node);
					} else {
						parent.insertBefore(fragment, node);
					}
				}
				parent.removeChild(node);
			}
		}
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

