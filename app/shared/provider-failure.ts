/**
 * Provider-level failures that cannot be repaired inside the task (usage /
 * session / auth / quota / context banners from the coding CLI). Keep this
 * narrow: generic OS/HTTP phrases like "permission denied" or "forbidden" show
 * up in ordinary tool stderr and must not abort the chat.
 */
export function providerFailure(output: string): string | null {
  const match =
    /(?:authentication failed|not authenticated|rate[ _-]limit(?:ed|[ _-]?error|\s+(?:exceeded|reached))?|429(?:\s|$)|(?:usage|session) limit|quota exceeded|insufficient (?:credits|quota)|maximum context length|context length exceeded)/i.exec(
      output
    )
  return match ? match[0] : null
}
