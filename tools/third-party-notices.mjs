import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** The notices file shipped in the package, next to the licence of the module itself. */
export const NOTICES_FILE = "THIRD-PARTY-NOTICES.md";
const LICENCE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "license", "license.md", "license.txt"];
const squash = text => text.replace(/\s+/g, " ").trim();

async function licenceOf(directory) {
  for (const file of LICENCE_FILES) {
    try { return await readFile(join(directory, file), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return null;
}

/**
 * What is wrong with the third-party notices of a module folder. The release bundle inlines every runtime dependency
 * (`dependencies` of package.json) and drops its legal comments, so the package must carry, for each one, its name and
 * installed version and the text of its licence as the package publishes it. Whitespace is not compared. The module has
 * no runtime dependency today and then needs no notices file; adding one makes this demand it.
 *
 * @param {string} root  The module folder, with its dependencies installed.
 * @returns {Promise<string[]>}  One message per problem; empty when the notices are complete.
 */
export async function noticeProblems(root) {
  const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (!Object.keys(metadata.dependencies ?? {}).length) return [];
  let notice;
  try { notice = squash(await readFile(join(root, NOTICES_FILE), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return [`${NOTICES_FILE} is missing`]; throw error; }
  const problems = [];
  for (const name of Object.keys(metadata.dependencies ?? {})) {
    const directory = join(root, "node_modules", name);
    let installed;
    try { installed = JSON.parse(await readFile(join(directory, "package.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") { problems.push(`${name} is not installed (run npm ci)`); continue; } throw error; }
    if (!notice.includes(`${name} ${installed.version}`)) problems.push(`${NOTICES_FILE} does not name ${name} ${installed.version}`);
    const licence = await licenceOf(directory);
    if (!licence) problems.push(`${name} ${installed.version} publishes no licence file to reproduce`);
    else if (!notice.includes(squash(licence))) problems.push(`${NOTICES_FILE} does not carry the licence text of ${name} ${installed.version}`);
  }
  return problems;
}
