import { App, PluginSettingTab, Setting } from 'obsidian';
import RecordingIndicatorPlugin from './main';

export class RecordingIndicatorSettingTab extends PluginSettingTab {
	plugin: RecordingIndicatorPlugin;

	constructor(app: App, plugin: RecordingIndicatorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();
		containerEl.addClass('recording-indicator-settings');

		containerEl.createEl('h2', { text: 'Horodatages universels' });

		containerEl.createEl('p', {
			text: 'Insérez des horodatages pendant vos prises de notes puis associez-les à un enregistrement importé. Les placeholders seront transformés en liens #t=… lors de l’association.'
		});

		containerEl.createEl('h3', { text: 'Affichage' });

		new Setting(containerEl)
			.setName('Format des horodatages')
			.setDesc('Utilisez {time} pour afficher la valeur calculée (exemple : "[{time}]").')
			.addText((text) =>
				text
					.setPlaceholder('[{time}]')
					.setValue(this.plugin.settings.timecodeFormat)
					.onChange(async (value) => {
						this.plugin.settings.timecodeFormat = value.trim() || '[{time}]';
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Afficher les secondes')
			.setDesc('Inclut les secondes dans les labels visibles et les liens générés.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showSeconds).onChange(async (value) => {
					this.plugin.settings.showSeconds = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Décalage temporel (secondes)')
			.setDesc('Décalage à appliquer aux horodatages insérés (positif ou négatif). Exemple : -5 pour avancer de 5 secondes, +10 pour retarder de 10 secondes.')
			.addText((text) =>
				text
					.setPlaceholder('0')
					.setValue(this.plugin.settings.timeOffsetSeconds.toString())
					.onChange(async (value) => {
						const numValue = Number.parseInt(value, 10);
						if (!Number.isNaN(numValue)) {
							this.plugin.settings.timeOffsetSeconds = numValue;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName('Intervalle d\'ajustement')
			.setDesc('Nombre de secondes à ajouter/retirer avec les boutons +/- du widget de timecode.')
			.addText((text) =>
				text
					.setPlaceholder('10')
					.setValue(this.plugin.settings.timecodeAdjustmentSeconds.toString())
					.onChange(async (value) => {
						const numValue = Number.parseInt(value, 10);
						if (!Number.isNaN(numValue) && numValue > 0) {
							this.plugin.settings.timecodeAdjustmentSeconds = numValue;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName('Regex personnalisée (nom de fichier)')
			.setDesc('Optionnel. Utilisez une regex avec groupes nommés pour extraire l\'heure de début depuis le nom audio. Groupes supportés : year, month, day, hour, minute, second, time (HHMMSS), time_dot (HH.MM.SS), ddmmyy.')
			.addTextArea((text) =>
				text
					.setPlaceholder('Ex: T(?<time>\\d{6})-(?<ddmmyy>\\d{6})')
					.setValue(this.plugin.settings.fileNameTimecodeRegex)
					.onChange(async (value) => {
						this.plugin.settings.fileNameTimecodeRegex = value.trim();
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl('h3', { text: 'Notifications' });

		new Setting(containerEl)
			.setName('Notifications')
			.setDesc('Affiche des notifications lors de l\'insertion ou de l\'association des horodatages.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showNotifications).onChange(async (value) => {
					this.plugin.settings.showNotifications = value;
					await this.plugin.saveSettings();
				})
			);

		containerEl.createEl('h3', { text: 'Lecture' });

		new Setting(containerEl)
			.setName('Timecode : lecture dans la note')
			.setDesc('Au clic sur un timecode, déplacer la lecture dans le lecteur audio déjà présent dans la note au lieu d\'ouvrir un panneau.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.seekTimecodeInPagePlayer).onChange(async (value) => {
					this.plugin.settings.seekTimecodeInPagePlayer = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Debug clic timecode (console)')
			.setDesc('Affiche dans la console (Ctrl+Shift+I) les étapes au clic sur un timecode pour diagnostiquer les problèmes.')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.debugTimecodeClick).onChange(async (value) => {
					this.plugin.settings.debugTimecodeClick = value;
					await this.plugin.saveSettings();
				})
			);

		containerEl.createEl('h3', { text: 'Conseils' });

		const tips = containerEl.createEl('div');
		tips.innerHTML = `
			<ul>
				<li>Utilisez <code>Ctrl+Shift+T</code> pour insérer un horodatage universel à tout moment.</li>
				<li>Nommez vos fichiers audio avec leur date/heure de démarrage (ex. <code>2025-11-07 16.32.23.m4a</code>) pour pré-remplir automatiquement l'heure de début.</li>
				<li>Pour des noms personnalisés, configurez la regex (ex. <code>T(?&lt;time&gt;\\d{6})-(?&lt;ddmmyy&gt;\\d{6})</code> ou <code>(?&lt;year&gt;\\d{4})-(?&lt;month&gt;\\d{2})-(?&lt;day&gt;\\d{2}).*?(?&lt;time_dot&gt;\\d{2}\\.\\d{2}\\.\\d{2})</code>).</li>
				<li>Après import, lancez la commande <em>Associer un fichier audio aux horodatages</em> puis indiquez l'heure exacte de démarrage de l'enregistrement.</li>
			</ul>
		`;
	}
}

