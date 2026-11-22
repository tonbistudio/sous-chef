// Makes Sous Chef.exe: Electron's program under the editor's own name, icon and file details,
// set to run the editor straight from this source folder. Changes to the code apply on the next start,
// with nothing to reinstall; run this again only after Electron itself is upgraded.
//   npm run launcher            -> ./launcher/Sous Chef.exe
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rcedit } from "rcedit";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "Sous Chef";
const src = path.join(root, "node_modules", "electron", "dist");
const out = path.join(root, "launcher");
const exe = path.join(out, `${NAME}.exe`);
const entry = path.join(root, "packages", "desktop", "dist", "main.js");
const icon = path.join(root, "packages", "desktop", "assets", "icon.ico");
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;

if (process.platform !== "win32") throw new Error("The launcher is for Windows; elsewhere use npm run desktop.");
if (!existsSync(entry)) throw new Error("Build first: npm run build");

rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true, filter: (f) => !f.endsWith("default_app.asar") });
renameSync(path.join(out, "electron.exe"), exe);

// The app Electron finds in resources/app: a stub that loads the editor from the source folder.
const app = path.join(out, "resources", "app");
mkdirSync(app, { recursive: true });
writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "sous-chef", productName: NAME, version, type: "module", main: "main.js" }, null, 2));
writeFileSync(path.join(app, "main.js"), `// Runs the editor from its source folder, so code changes apply on the next start.\nawait import(${JSON.stringify(pathToFileURL(entry).href)});\n`);

await rcedit(exe, {
  icon,
  "file-version": version,
  "product-version": version,
  "version-string": { FileDescription: NAME, ProductName: NAME, InternalName: NAME, OriginalFilename: `${NAME}.exe`, CompanyName: "Sous Chef contributors", LegalCopyright: "MIT License" },
});
console.log(`Made ${exe}\nStart it once; it puts "${NAME}" in the Start menu, which you can pin to the taskbar.`);
