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
     * Terminal success block: pairing QR, then the LAN address and token. `qr` is
     * the pre-rendered code (install.js owns qrcode-terminal); nothing else prints
     * after this.
     */
    result({ qr, url, token }) {
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
      if (url) write(`  ${dim("地址")}  ${url}\n`);
      if (token) write(`  ${dim("令牌")}  ${token}\n`);
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
