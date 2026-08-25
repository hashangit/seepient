import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PiCatalogSource } from '../src/vendors/pi-ai/pi-catalog-source.js';

async function main(): Promise<void> {
  const source = new PiCatalogSource();
  const models = await source.list();
  const targetPath = resolve(process.cwd(), 'src/vendors/pi-ai/__tests__/fixtures/frozen-catalog.json');
  writeFileSync(targetPath, JSON.stringify(models, null, 2), 'utf-8');
  console.log(`Successfully snapshotted ${models.length} models to ${targetPath}`);
}

main().catch((err) => {
  console.error('Failed to snapshot catalog fixture:', err);
  process.exit(1);
});
