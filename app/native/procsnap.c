/*
 * procsnap: one JSON line per "tick" on stdin, listing the caller's own
 * processes. Memory is the physical footprint (ri_phys_footprint), the number
 * Activity Monitor shows; RSS would double-count shared pages.
 *
 *   clang -O2 -arch arm64 -arch x86_64 procsnap.c -o ../build/procsnap
 *
 * A row: pid, ppid, pgid, uid, start (sec, usec), fp (bytes), cpu (ns, user +
 * system), name, args (truncated) and cwd. The cwd costs one extra call, so
 * it is read only for processes reparented to launchd (ppid 1), the only ones
 * that can be orphans.
 */
#include <libproc.h>
#include <mach/mach_time.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <sys/sysctl.h>
#include <unistd.h>

#define ARGS_MAX_OUT 240

static void json_str(const char *s, size_t max) {
  putchar('"');
  for (size_t i = 0; s[i] && i < max; i++) {
    unsigned char c = (unsigned char)s[i];
    if (c == '"' || c == '\\') {
      putchar('\\');
      putchar(c);
    } else if (c < 0x20) {
      printf("\\u%04x", c);
    } else {
      putchar(c);
    }
  }
  putchar('"');
}

/* KERN_PROCARGS2: argc, exec path, NUL padding, then argc strings. */
static int read_args(pid_t pid, char *buf, size_t cap, char *out, size_t outsz) {
  int mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};
  size_t size = cap;
  if (sysctl(mib, 3, buf, &size, NULL, 0) != 0 || size < sizeof(int)) return 0;
  int argc;
  memcpy(&argc, buf, sizeof argc);
  char *p = buf + sizeof argc, *end = buf + size;
  while (p < end && *p) p++;
  while (p < end && !*p) p++;
  size_t len = 0;
  for (int i = 0; i < argc && p < end && len + 1 < outsz; i++) {
    size_t n = strnlen(p, (size_t)(end - p));
    if (i) out[len++] = ' ';
    size_t take = n < outsz - len - 1 ? n : outsz - len - 1;
    memcpy(out + len, p, take);
    len += take;
    p += n + 1;
  }
  out[len] = 0;
  return 1;
}

int main(void) {
  mach_timebase_info_data_t tb;
  mach_timebase_info(&tb);
  uid_t me = geteuid();

  int argmax = 0;
  size_t argmax_size = sizeof argmax;
  int mib[2] = {CTL_KERN, KERN_ARGMAX};
  if (sysctl(mib, 2, &argmax, &argmax_size, NULL, 0) != 0 || argmax <= 0) argmax = 262144;
  char *argbuf = malloc((size_t)argmax);
  if (!argbuf) return 1;

  pid_t *pids = NULL;
  int cap = 0;
  char line[32];
  setvbuf(stdout, NULL, _IOFBF, 1 << 16);

  while (fgets(line, sizeof line, stdin)) {
    int want = proc_listallpids(NULL, 0) + 64;
    if (want > cap) {
      free(pids);
      pids = malloc((size_t)want * sizeof(pid_t));
      if (!pids) return 1;
      cap = want;
    }
    int count = proc_listallpids(pids, cap * (int)sizeof(pid_t));

    printf("{\"p\":[");
    int first = 1;
    for (int i = 0; i < count; i++) {
      pid_t pid = pids[i];
      if (pid <= 0) continue;
      struct proc_bsdinfo bi;
      if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bi, sizeof bi) != (int)sizeof bi) continue;
      if (bi.pbi_uid != me) continue;

      struct rusage_info_v4 ru;
      uint64_t fp = 0, cpu = 0;
      if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&ru) == 0) {
        fp = ru.ri_phys_footprint;
        cpu = (ru.ri_user_time + ru.ri_system_time) * tb.numer / tb.denom;
      }

      char args[ARGS_MAX_OUT + 1] = "";
      read_args(pid, argbuf, (size_t)argmax, args, sizeof args);

      if (!first) putchar(',');
      first = 0;
      printf("{\"pid\":%d,\"ppid\":%u,\"pgid\":%u,\"uid\":%u,\"sec\":%llu,\"usec\":%llu,\"fp\":%llu,\"cpu\":%llu,\"name\":",
             pid, bi.pbi_ppid, bi.pbi_pgid, bi.pbi_uid, (unsigned long long)bi.pbi_start_tvsec,
             (unsigned long long)bi.pbi_start_tvusec, (unsigned long long)fp, (unsigned long long)cpu);
      json_str(bi.pbi_name[0] ? bi.pbi_name : bi.pbi_comm, 64);
      printf(",\"args\":");
      json_str(args, ARGS_MAX_OUT);
      if (bi.pbi_ppid == 1) {
        struct proc_vnodepathinfo vpi;
        if (proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &vpi, sizeof vpi) == (int)sizeof vpi) {
          printf(",\"cwd\":");
          json_str(vpi.pvi_cdir.vip_path, MAXPATHLEN);
        }
      }
      putchar('}');
    }
    printf("]}\n");
    fflush(stdout);
  }
  return 0;
}
