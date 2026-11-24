import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseNotes } from '../ui/release-notes.mjs';

export function formatReleaseNotes(release) {
  const blocks = [release.summary];
  for (const section of release.sections) {
    blocks.push(`## ${section.heading}`);
    blocks.push(...section.paragraphs || []);
    for (const command of section.commands || []) {
      if (command.label) blocks.push(command.label);
      blocks.push(`\`\`\`sh\n${command.code}\n\`\`\``);
    }
    if (section.items?.length) blocks.push(section.items.map(item => `- ${item}`).join('\n'));
    if (section.links?.length) blocks.push(section.links.map(item => `[${item.label}](${item.url})`).join(' · '));
  }
  return blocks.join('\n\n') + '\n';
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [version, output] = process.argv.slice(2);
  const release = releaseNotes.find(item => item.version === version && !item.local);
  if (!release || !output) throw Error('用法：node tools/release-notes.mjs <已发布版本，如 1.0.5> <输出 Markdown 文件>');
  const target = resolve(output);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, formatReleaseNotes(release), 'utf8');
  console.log(`已生成 v${release.version} 发行说明：${target}`);
}
