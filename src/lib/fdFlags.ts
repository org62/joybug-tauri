// Linux open(2) flags as the Handles window shows them for a file descriptor
// (the backend ships the raw `flags:` word of /proc/pid/fdinfo in
// `granted_access`). Values are the x86-64 / generic ones.

const ACCESS_MODES = ["O_RDONLY", "O_WRONLY", "O_RDWR"];

const FLAG_BITS: [number, string][] = [
  [0o100, "O_CREAT"],
  [0o200, "O_EXCL"],
  [0o400, "O_NOCTTY"],
  [0o1000, "O_TRUNC"],
  [0o2000, "O_APPEND"],
  [0o4000, "O_NONBLOCK"],
  [0o10000, "O_DSYNC"],
  [0o40000, "O_DIRECT"],
  [0o200000, "O_DIRECTORY"],
  [0o400000, "O_NOFOLLOW"],
  [0o1000000, "O_NOATIME"],
  [0o2000000, "O_CLOEXEC"],
  [0o10000000, "O_PATH"],
];

/** `O_LARGEFILE`: set on every 64-bit open, so it says nothing. */
const O_LARGEFILE = 0o100000;

/** `O_RDWR|O_NONBLOCK|O_CLOEXEC` for an fdinfo flags word. */
export function formatFdFlags(flags: number): string {
  const parts = [ACCESS_MODES[flags & 3] ?? "O_ACCMODE"];
  let rest = flags & ~3 & ~O_LARGEFILE;
  for (const [bit, name] of FLAG_BITS) {
    if (rest & bit) {
      parts.push(name);
      rest &= ~bit;
    }
  }
  if (rest) parts.push(`0${rest.toString(8)}`);
  return parts.join("|");
}
