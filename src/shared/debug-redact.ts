/** Strip API contact parameters and email addresses from diagnostic text. */
export function redactDebugText(text: string): string {
  return text
    .replace(/([?&](?:mailto|email)=)[^&#\s"'<>]*/gi, "$1[redacted]")
    // Reports can contain URLs that were themselves encoded into another URL.
    .replace(/((?:%3f|%26)(?:mailto|email)%3d)(?:(?!%26|%23)[^\s"'<>])*/gi, "$1[redacted]")
    .replace(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+(?:@|%40)[a-z0-9.-]+\.[a-z]{2,}/gi, "[redacted email]");
}
