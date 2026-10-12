# Installer le MCP AFFiNE (version ceepia) dans Claude Desktop

Guide destiné à un agent (Claude Code ou autre) qui installe ce serveur MCP sur la machine de l'utilisateur.
Instance AFFiNE : `https://affine.ceepia.tech`.

## Règles pour l'agent

- Ne demande jamais le mot de passe AFFiNE dans le chat. L'étape 3 se fait par l'utilisateur, dans son propre terminal.
- Avant de modifier `claude_desktop_config.json`, lis-le et garde les serveurs déjà présents. Ajoute seulement l'entrée `affine`.
- Utilise des chemins absolus partout : Claude Desktop ne voit pas le `PATH` du shell (nvm, Homebrew…).

## 1. Prérequis

```bash
node -v   # doit afficher v20.18.1 ou plus
git --version
```

Si Node manque ou est trop vieux : installer Node 22 LTS (`brew install node@22` sur macOS, ou https://nodejs.org).

## 2. Cloner et compiler

```bash
mkdir -p ~/mcp && cd ~/mcp
git clone -b ceepia https://github.com/Kadnat/affine-mcp-server.git
cd affine-mcp-server
npm install
npm run build
```

Vérifie que `dist/index.js` existe. Note les deux chemins absolus pour l'étape 4 :

```bash
command -v node                         # ex. /opt/homebrew/bin/node
echo "$PWD/bin/affine-mcp"              # ex. /Users/ge/mcp/affine-mcp-server/bin/affine-mcp
```

Sur Windows, utiliser `where node` et le chemin `C:\...\affine-mcp-server\bin\affine-mcp`.

## 3. Connexion à AFFiNE (à faire par l'utilisateur)

Demande à l'utilisateur de lancer lui-même cette commande dans son terminal (dans Claude Code : la préfixer par `! `) :

```bash
cd ~/mcp/affine-mcp-server && AFFINE_BASE_URL=https://affine.ceepia.tech node bin/affine-mcp login --save-credentials
```

- URL : appuyer sur Entrée (https://affine.ceepia.tech est déjà proposée)
- Méthode : email / mot de passe de son compte AFFiNE ceepia
- Workspace : choisir le workspace ceepia

Les identifiants sont enregistrés dans `~/.config/affine-mcp/config` (droits `600`), et pas dans la config de Claude.

Vérification :

```bash
node bin/affine-mcp workspaces
```

## 4. Configurer Claude Desktop

Fichier de config :

- macOS : `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows : `%APPDATA%\Claude\claude_desktop_config.json`

Ajoute (ou fusionne) dans `mcpServers`, en remplaçant les deux chemins par ceux de l'étape 2 :

```json
{
  "mcpServers": {
    "affine": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/ge/mcp/affine-mcp-server/bin/affine-mcp"]
    }
  }
}
```

Le serveur lit lui-même l'URL et les identifiants dans `~/.config/affine-mcp/config`. Aucun `env` n'est nécessaire.

## 5. Redémarrer et tester

1. Quitter complètement Claude Desktop (Cmd+Q sur macOS, pas juste fermer la fenêtre), puis le relancer.
2. Dans une nouvelle conversation, demander : « Liste mes workspaces AFFiNE ».
3. Les outils `affine` doivent apparaître dans le menu des connecteurs/outils.

En cas d'échec, regarder les logs :

- macOS : `~/Library/Logs/Claude/mcp-server-affine.log`
- Windows : `%APPDATA%\Claude\logs\mcp-server-affine.log`

Causes fréquentes : chemin de `node` non absolu, `npm run build` pas lancé, login pas fait.

## Mise à jour

```bash
cd ~/mcp/affine-mcp-server && git pull && npm install && npm run build
```

Puis redémarrer Claude Desktop.
