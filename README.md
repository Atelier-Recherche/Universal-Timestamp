# Universal Timestamp - Plugin Obsidian

Un plugin Obsidian pour prendre des notes pendant une session enregistrée (audio ou vidéo) en générant des **horodatages universels** basés sur l’horloge système. Une fois l’enregistrement importé, les horodatages sont convertis en liens `#t=` cliquables.

## 🌟 Fonctionnalités

- **📝 Horodatages universels** : `Ctrl+Shift+T` insère un marqueur horodaté (`%%REC{...}%%`) accompagné d’un libellé lisible.
- **🔗 Conversion contrôlée** : commande “Associer un fichier audio aux horodatages” pour transformer les marqueurs en liens `[[fichier#t=123|[02:03]]]`.
- **🔔 Proposition contextuelle** : lorsqu’un lien vers un fichier audio est inséré dans la note, le plugin peut proposer immédiatement de lancer la conversion (aucune action forcée).
- **📂 Reconnaissance des fichiers** : détection automatique des fichiers audio (MP3, WAV, M4A, OGG, WebM, MP4, AAC, FLAC) déjà présents dans le coffre.
- **⚙️ Paramètres épurés** : format du libellé `{time}`, affichage ou non des secondes, notifications.

## 📦 Installation

### Installation manuelle

1. Téléchargez les fichiers `main.js`, `manifest.json` et `styles.css`
2. Créez un dossier `universal-timestamp` dans votre dossier `.obsidian/plugins/`
3. Placez les fichiers téléchargés dans ce dossier
4. Redémarrez Obsidian
5. Activez le plugin dans les paramètres

### Installation via BRAT (recommandée)

1. Installez le plugin [BRAT](https://github.com/TfTHacker/obsidian42-brat)
2. Ajoutez ce dépôt : `https://github.com/Morglaf/Universal-Timestamp`
3. Activez le plugin dans les paramètres

> **ID plugin (catalogue Obsidian)** : `universal-timestamp` — le dossier dans `.obsidian/plugins/` doit s’appeler **`universal-timestamp`**.

## 🚀 Utilisation

### 1. Pendant la prise de notes

- À chaque repère temporel souhaité, utilisez la commande **“Insérer un horodatage universel”** (`Ctrl+Shift+T` par défaut).
- Un placeholder du type `%%REC{"time":"2025-11-08T16:32:23.123Z"}%%[16:32:23]` est inséré à l’emplacement du curseur.

### 2. Après l’enregistrement

- Copiez ou importez le fichier audio/vidéo (depuis un téléphone, un enregistreur externe, etc.) dans votre coffre Obsidian.
- Si le fichier possède un nom incluant la date/heure de démarrage (`2025-11-07 16.32.23.m4a`, par exemple), le plugin pré-remplira automatiquement l’heure de début.

### 3. Conversion des horodatages

- Ouvrez la note contenant vos placeholders.
- Lancez la commande **“Associer un fichier audio aux horodatages”**.
  - Choisissez le fichier audio à lier (le champ est automatiquement renseigné avec la note ouverte).
  - Ajustez l’heure de démarrage si nécessaire (format `YYYY-MM-DD HH:mm:ss`).
- Tous les placeholders référencés sont remplacés par des liens `#t=` cliquables.

### Suggestions contextuelles

- Si vous ajoutez un lien `[[...]]` vers un fichier audio reconnu, une fenêtre vous propose de lancer immédiatement la conversion (vous pouvez refuser et le faire plus tard).

## ⚙️ Paramètres

- **Format des horodatages** : personnalisez l’affichage visible (`[{time}]`, `({time})`, etc.).
- **Afficher les secondes** : active/désactive les secondes dans les libellés et les liens.
- **Notifications** : affiche des notifications lors de l’insertion et/ou de la conversion.

## 📋 Commandes disponibles

- `Insérer un horodatage universel`
- `Associer un fichier audio aux horodatages`

## 🔧 Développement

### Prérequis

- Node.js 16+
- npm ou yarn

### Installation des dépendances

```bash
npm install
```

### Développement

```bash
npm run dev
```

### Build de production

```bash
npm run build
```

## 🤝 Contribution

Les contributions sont les bienvenues ! N'hésitez pas à :

1. Fork le projet
2. Créer une branche pour votre fonctionnalité
3. Commiter vos changements
4. Pousser vers la branche
5. Ouvrir une Pull Request

## 📝 Licence

Ce projet est sous licence MIT. Voir le fichier [LICENSE](LICENSE) pour plus de détails.

## 🙏 Remerciements

Inspiré par le plugin [Media Extended](https://github.com/aidenlx/media-extended) mais avec un focus sur l'indicateur d'enregistrement et la compatibilité mobile.

## 🐛 Signaler un bug

Si vous rencontrez un problème, ouvrez une [issue](https://github.com/Morglaf/Universal-Timestamp/issues).

## Conformité catalogue Obsidian

| Élément | Détail |
| --- | --- |
| **Licence** | MIT — [LICENSE](LICENSE) |
| **Réseau** | non — horodatages locaux, fichiers audio dans le coffre uniquement |
| **Fichiers hors vault** | non |
| **Télémétrie / mise à jour auto** | non |
| **Release** | `.\Release-Plugin.ps1` |

## 📱 Compatibilité

| Plateforme | Statut |
|------------|--------|
| Windows Desktop | ✅ Supporté |
| macOS Desktop | ✅ Supporté |
| Linux Desktop | ✅ Supporté |
| Android | ✅ Supporté |
| iOS | ✅ Supporté |

---

**Note** : le plugin n’enregistre pas l’audio. Il se concentre sur la prise de notes et la synchronisation temporelle avec un enregistrement externe.