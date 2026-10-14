/**
 * Every reason the map import reports. Each code has a message at `JDRNINJA.maps.error.<code>`; the `details` of a
 * MapError fill its placeholders (`{file}`, `{level}`, `{detail}`, `{name}`, `{folder}`, `{version}`).
 */
export const MAP_ERROR_CODES = Object.freeze([
  "notGM", "noUpload", "noBrowse", "busy", "noFile", "readerUnavailable", "notZip", "tooLarge", "tooManyEntries", "unsafeName",
  "missingDescription", "badDescription", "unsupportedFormat", "unsupportedVersion", "missingImage", "badImage",
  "invalidFolder", "folderFailed", "folderUnreadable", "uploadFailed", "sceneFailed", "unknown",
]);

export class MapError extends Error {
  /**
   * @param {string} code      One of MAP_ERROR_CODES.
   * @param {object} [details] Values for the message placeholders. `uploaded` lists the files already sent when an
   *                           import fails halfway.
   * @param {unknown} [cause]  The error that made this one.
   */
  constructor(code, details = {}, cause) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "MapError";
    this.code = code;
    this.details = details;
  }
}
