/**
 * Installer UI — the whole visual surface of `install.js`, kept here so it can be
 * driven by a mock (`scripts/preview-install-ui.mjs`) without touching a real
 * gateway. install.js decides WHAT happens; this file decides how it LOOKS.
 *
 * Shape: one line per step, live spinner while it runs, resolved to ✔/✘ with an
 * optional dim detail. No explanatory prose — a successful install prints four
 * step lines, the pairing QR, and the URL/token. Anything longer belongs in the
 * docs, not in a terminal the user watches for ten seconds.
 *
 * Non-TTY (pipe, CI, `| tee`): no spinner, no redraws — each step prints once when
 * it resolves, so the log stays readable.
 */

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

/** Terminal columns a string occupies — CJK/fullwidth code points take two. */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    w +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)
        ? 2
        : 1;
  }
  return w;
}

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
};

/**
 * @param {object} [opts]
 * @param {NodeJS.WritableStream} [opts.stream] output sink (mock passes its own)
 * @param {boolean} [opts.tty] force TTY behavior on/off (mock forces it on)
 */
export function createInstallerUI(opts = {}) {
  const stream = opts.stream ?? process.stdout;
  const isTTY = opts.tty ?? Boolean(stream.isTTY);
  const color = opts.color ?? isTTY;

  const paint = (code, s) => (color ? code + s + ANSI.reset : s);
  const dim = (s) => paint(ANSI.dim, s);
  const write = (s) => stream.write(s);

  let timer = null;
  let frame = 0;
  /** @type {{label: string, detail: string} | null} */
  let running = null;

  const stepLine = (mark, label, detail) => `  ${mark} ${label}${detail ? "  " + dim(detail) : ""}`;

  function redraw() {
    if (!running) return;
    const mark = paint(ANSI.yellow, SPINNER_FRAMES[frame % SPINNER_FRAMES.length]);
    write("\r\x1b[2K" + stepLine(mark, running.label, running.detail));
  }

  function stopSpinner() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (isTTY) write("\r\x1b[2K");
  }

  return {
    /** Product banner. One line, no version chatter. */
    header(subtitle) {
      write("\n  " + paint(ANSI.bold, "Friday Next"));
      if (subtitle) write(dim("  " + subtitle));
      write("\n\n");
    },

    /**
     * Begin a step. Returns a handle: `detail()` updates the trailing note while it
     * runs, then exactly one of `ok()` / `fail()` resolves the line.
     */
    step(label) {
      running = { label, detail: "" };
      if (isTTY) {
        frame = 0;
        redraw();
        timer = setInterval(() => {
          frame += 1;
          redraw();
        }, SPINNER_INTERVAL_MS);
      }
      const resolve = (mark, detail) => {
        const finished = running;
        stopSpinner();
        running = null;
        if (!finished) return;
        write(stepLine(mark, finished.label, detail ?? finished.detail) + "\n");
      };
      return {
        detail(text) {
          if (running) running.detail = text;
          if (isTTY) redraw();
        },
        ok(detail) {
          resolve(paint(ANSI.green, "✔"), detail);
        },
        fail(detail) {
          resolve(paint(ANSI.red, "✘"), detail);
        },
      };
    },

    /** A non-fatal aside (skipped optional feature, degraded path). One short line. */
    note(text) {
      write(stepLine(paint(ANSI.yellow, "!"), dim(text), "") + "\n");
    },

    /**
     * Terminal success block: a one-line call to action, then the pairing QR. `qr` is
     * the pre-rendered code (install.js owns qrcode-terminal); `hint` is that line.
     * `fields` (`[{label, value}]`) is the manual fallback — only passed when the QR
     * could not be rendered, since the code itself is the pairing path. All copy comes
     * from the caller so this file stays language-agnostic. Nothing prints after this.
     */
    result({ qr, hint, fields = [] }) {
      if (hint) write("\n  " + hint + "\n");
      if (qr) {
        // Indent the code to the step lines' margin; keep the quiet zone intact.
        const body = qr
          .replace(/\n$/, "")
          .split("\n")
          .map((l) => "  " + l)
          .join("\n");
        write("\n" + body + "\n");
      }
      write("\n");
      const shown = fields.filter((f) => f?.value);
      // Column-aware padding: CJK labels are two columns per character, so a plain
      // `.length` pad would misalign a 中文 label against an English one.
      const width = Math.max(0, ...shown.map((f) => displayWidth(f.label)));
      for (const { label, value } of shown) {
        const pad = " ".repeat(width - displayWidth(label));
        write(`  ${dim(label)}${pad}  ${value}\n`);
      }
      write("\n");
    },

    /**
     * Fatal exit block. `lines[0]` is what went wrong; the rest are commands the
     * user can run. Kept to the minimum that makes the failure actionable.
     */
    fatal(lines) {
      write("\n");
      for (const [i, line] of lines.entries()) {
        write(i === 0 ? `  ${paint(ANSI.red, "✘")} ${line}\n` : `  ${dim("→ " + line)}\n`);
      }
      write("\n");
    },

    /** Release the spinner if the process dies mid-step. */
    cleanup() {
      stopSpinner();
      running = null;
    },
  };
}
