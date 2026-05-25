/** User display-name helpers: a curated adjective-noun generator for signup
 * defaults (e.g. `brave-ember`) and a validator shared by the CLI and the
 * self-edit profile endpoint. */

const MAX_LENGTH = 48;

const ADJECTIVES = [
  "brave", "calm", "clever", "cosmic", "eager", "fancy", "fire", "gentle",
  "happy", "jolly", "keen", "lucky", "mellow", "nimble", "quiet", "rapid",
  "sleepy", "snowy", "solar", "spry", "sunny", "swift", "vivid", "witty"
] as const;

const NOUNS = [
  "badger", "cedar", "comet", "cow", "ember", "falcon", "fox", "harbor",
  "heron", "lynx", "maple", "meadow", "otter", "pebble", "quartz", "raven",
  "river", "spark", "sparrow", "thistle", "tiger", "willow", "wolf", "zephyr"
] as const;

/** Random `adjective-noun` label, e.g. `sleepy-cow`. */
export function generateDisplayName(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adjective}-${noun}`;
}

/** Trim, strip control chars/newlines, enforce length 1–48. Throws on empty
 * or over-length. Returns the normalized value. */
export function validateDisplayName(raw: string): string {
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!cleaned) {
    throw new Error("display name must not be empty");
  }
  if (cleaned.length > MAX_LENGTH) {
    throw new Error(`display name must be at most ${MAX_LENGTH} characters`);
  }
  return cleaned;
}
