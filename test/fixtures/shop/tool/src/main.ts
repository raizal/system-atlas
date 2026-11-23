import { formatPrice } from '../../core/src/index';

export function main(argv: string[]): number {
  for (const a of argv) {
    if (a === '--help') return 0;
    if (a === '--price') console.log(formatPrice(1250));
  }
  return 1;
}
