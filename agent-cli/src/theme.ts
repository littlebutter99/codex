import { stripVTControlCharacters } from 'node:util';
import { stripTerminalSequences } from '@earendil-works/pi-tui';

export const clean = (value: unknown) => stripVTControlCharacters(stripTerminalSequences(String(value)))
  .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
export const color = (code: string) => (text: string) => `\x1b[${code}m${text}\x1b[0m`;
export const cyan = color('36'), dim = color('2'), green = color('32'), amber = color('33');
export const bold = color('1'), red = color('31');
