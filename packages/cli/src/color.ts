const CSI = "\u001B[";

/** Honors NO_COLOR and FORCE_COLOR, and falls back to TTY detection. */
export function supportsColor(): boolean {
  if (process.env["NO_COLOR"] !== undefined) return false;
  if (process.env["FORCE_COLOR"] !== undefined) return true;
  return process.stdout.isTTY === true;
}

function wrap(code: number, text: string, enabled: boolean): string {
  return enabled ? `${CSI}${code}m${text}${CSI}0m` : text;
}

export const green = (text: string, on: boolean): string => wrap(32, text, on);
export const red = (text: string, on: boolean): string => wrap(31, text, on);
export const dim = (text: string, on: boolean): string => wrap(2, text, on);
export const bold = (text: string, on: boolean): string => wrap(1, text, on);
