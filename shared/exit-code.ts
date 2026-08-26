/** Turning a killing signal into the exit code a shell would report. */

/**
 * POSIX signal numbers, as macOS and Linux agree on them. A table rather than
 * `os.constants` so this stays importable from anywhere and testable.
 */
const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 10,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 30,
  SIGSEGV: 11,
  SIGUSR2: 31,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGXCPU: 24,
  SIGXFSZ: 25
}

/**
 * `128 + signum`, the convention every shell uses — so a step killed by a
 * signal reports the same code BuildFlow's own terminal would show.
 *
 * This matters for diagnosis: collapsing every signal to 130 makes a crash
 * indistinguishable from someone pressing Stop. A Node process that runs out
 * of heap calls abort(), and 134 (SIGABRT) says exactly that, while 130
 * (SIGINT) sends the reader looking for a cancellation that never happened.
 */
export function exitCodeFromSignal(signal: string | number | null | undefined): number | null {
  if (signal === null || signal === undefined || signal === 0 || signal === '') return null
  const num = typeof signal === 'number' ? signal : SIGNAL_NUMBERS[signal]
  if (typeof num !== 'number' || !Number.isFinite(num) || num <= 0) return null
  return 128 + num
}
