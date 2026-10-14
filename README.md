# JDR Ninja for Foundry VTT

**Control your table. Sync your characters. Bring your rolls to the stream.**

An extension of the [JDR Ninja website](https://www.jdr.ninja), this module brings
the site's features directly into **Foundry VTT V14**.

Stream Deck control, Atlas character sync, live dice overlays, procedural D&D
creature generation, and multi-level map import in one module.

## Stream Deck: control Foundry with a button

**Control your character sheets from your Stream Deck.** Toggle inspiration,
spend a resource, or change any field you are allowed to edit, with one key.

Switch scenes, cue music, run macros, roll dice, and manage combat from your
**Elgato Stream Deck**. Open character sheets, target tokens, adjust resources,
and share journal pages without hunting through windows.

Buttons can follow your selected token or assigned character, with live game
state for feedback. Commands respect your Foundry permissions.

Requires the **JDR Ninja Stream Deck plugin**, installed separately. Local
Foundry control does not require a JDR Ninja account.

![Stream Deck window showing a ready connection to the Stream Deck plugin](docs/images/stream-deck.png)

[Set up Stream Deck →](https://www.jdr.ninja/en/guide-stream-deck-foundry)

## Atlas: keep your campaign's characters up to date

Link Foundry actors to **Atlas** characters, create new ones, and sync sheets
and portraits individually or together.

Supports **D&D5e, Pathfinder 2e, Starfinder 2e, The One Ring 2e, and WFRP4e**.
Synchronization is managed by the GM.

![Atlas Sync window with synced heroes and one character ready to create in Atlas](docs/images/atlas-sync.png)

[Connect Atlas →](https://www.jdr.ninja/en/integration-foundry/guide#connecter-atlas)

## VTT Overlay: put your rolls on stream

Show your **actual public Foundry rolls in OBS**, coordinated with **Dice So Nice**.
Filter to player rolls, adjust chat-card timing, and let Twitch commands draw
from approved RollTables.

Private rolls stay private. Live overlay rolls require a paid subscription.

![VTT Overlay window with roll forwarding, Twitch table draws and account diagnostics](docs/images/overlay.png)

[Set up the overlay →](https://www.jdr.ninja/en/integration-foundry/guide#activer-les-fonctions)

## D&D generators: from idea to Foundry actor

Use **procedural generation** to create a **monster or NPC**, preview the result,
and import it as a native Foundry actor with its items and activities.

GM-only, with premium access. Requires **Foundry V14 and D&D5e 5.3.3**.

![Actors directory with the Atlas Sync and D&D generator shortcuts, and the imported monster in a Bestiary folder](docs/images/actors-directory.png)

![D&D monster generator with its options and a generated creature preview](docs/images/monster-generator.png)

![The generated monster imported as a native D&D5e actor sheet](docs/images/monster-sheet.png)

[Connect the generators →](https://www.jdr.ninja/en/integration-foundry/guide#activer-les-fonctions)

## Maps: import a JDR Ninja map as a multi-level scene

Export a map from the **JDR Ninja map generator** as a Foundry ZIP, then import it
here. The file becomes **one scene with one level per floor**: the level images,
walls, doors and secret doors, windows and railings,
**stairs, ladders and lifts that offer the level change**, water, ice and tight
squeezes that slow movement, and drops that take a token down a floor.

1. In Foundry, open the **Scenes** tab and click **Import a JDR Ninja map**, or run
   `game.modules.get("jdr-ninja").api.openMapImport()`.
2. Choose the ZIP file. The window lists what it holds.
3. Check the destination folder, where the level images are uploaded in your
   Foundry data, and click **Import the map**.

GM-only, and your role needs the permissions to upload files and to use the file
browser. Importing a file **needs no JDR Ninja account connection**. Requires
**Foundry V14**. The images are never given the name of a file already in the
destination folder, so an earlier import is never overwritten. The scene is made of
native Foundry levels, walls and regions, so it keeps working if you disable the
module.

## Advanced controls: make your buttons go further

Reuse counters, toggles, text, document references, and lists. Feed values into
commands, define computed variables, and pass typed arguments to compatible macros.

The variable and macro editors also work locally without a Stream Deck connection.

Computed variables read document data with the same paths as Active Effects, such as
`@{Spotlight hero}.system.attributes.inspiration`. To find the path of a value, the
[Document Data Explorer](https://foundryvtt.com/packages/document-data-explorer) module
shows the data structure of any document from its sheet.

![Variables window with world variables and a computed value that reads the spotlight hero's inspiration](docs/images/variables.png)

![Compatible macros window declaring typed arguments for a damage macro](docs/images/macro-arguments.png)

[Explore advanced controls →](https://www.jdr.ninja/en/guide-stream-deck-foundry#options-avancees)

## Get started

1. Install the module using this manifest URL:

   ```text
   https://github.com/JDR-Ninja/fvtt-jdr-ninja/releases/latest/download/module.json
   ```

2. Enable **JDR Ninja** in your Foundry world.
3. Open **Configure Settings → JDR Ninja → Configure connections** and enable
   the features you want. Each integration starts disabled.

![JDR Ninja connections window with the account banner and one row per feature](docs/images/connections.png)

**Languages:** English, French, Spanish, German, and Italian.

[Installation and connection guide →](https://www.jdr.ninja/en/integration-foundry/guide)
· [JDR Ninja](https://www.jdr.ninja/en)

## Screenshots

Screenshots show invented demo content in Foundry VTT V14 with D&D5e 5.3.3.
Character portraits are Foundry VTT icons from [game-icons.net](https://game-icons.net),
created by [various authors](https://game-icons.net/about.html#authors) and licensed under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).
