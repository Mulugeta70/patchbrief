export const VERSION_MESSAGE = "Use a full version, like 18.19.1";
export function isDottedVersion(version: string): boolean {
  return version.length <= 50 && /^\d+(?:\.\d+)+$/.test(version);
}
