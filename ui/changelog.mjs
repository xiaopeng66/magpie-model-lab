import { releaseNotes } from './release-notes.mjs';

export function createChangelog({ $, document, openDrawer, closeDrawer }) {
  let currentVersion = releaseNotes[0].version;
  const node = (tag, className, text) => {
    const out = document.createElement(tag);
    if (className) out.className = className;
    if (text !== undefined) out.textContent = text;
    return out;
  };
  const link = (label, url) => {
    const out = node('a', 'changelog-link', label);
    out.href = url; out.target = '_blank'; out.rel = 'noopener noreferrer';
    return out;
  };
  function sectionView(section) {
    const root = node('section', 'changelog-section');
    root.append(node('h3', '', section.heading));
    for (const paragraph of section.paragraphs || []) root.append(node('p', '', paragraph));
    if (section.items?.length) {
      const list = node('ul', 'changelog-list');
      for (const item of section.items) list.append(node('li', '', item));
      root.append(list);
    }
    return root;
  }
  function releaseView(release) {
    const details = node('details', 'changelog-release'), summary = node('summary', 'changelog-summary');
    details.dataset.version = release.version;
    details.dataset.current = String(release.version === currentVersion);
    details.open = release.version === currentVersion;
    const heading = node('div', 'changelog-heading'), meta = node('div', 'changelog-meta');
    meta.append(node('strong', 'changelog-version', `v${release.version}`));
    if (details.open) meta.append(node('span', 'changelog-badge changelog-current', '当前版本'));
    if (release.local) meta.append(node('span', 'changelog-badge', '本地未发布'));
    const time = node('time', 'changelog-date', release.date); time.dateTime = release.date; meta.append(time);
    heading.append(meta, node('p', 'changelog-teaser', release.summary));
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'icon changelog-chevron'); icon.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', '#i-chevron'); icon.append(use);
    summary.append(heading, icon);
    const body = node('div', 'changelog-body');
    for (const section of release.sections) {
      if (section.heading === '更新内容' || section.heading === '体验优化') body.append(sectionView(section));
    }
    if (release.url) body.append(link('GitHub 发行说明', release.url));
    details.append(summary, body);
    return details;
  }
  function open() {
    const content = openDrawer('更新日志', $('release-notes'), 'reading');
    content.classList.add('changelog-content');
    const list = node('div', 'changelog-releases');
    for (const release of releaseNotes) list.append(releaseView(release));
    content.append(list);
    const close = node('button', '', '关闭'); close.type = 'button'; close.addEventListener('click', closeDrawer);
    $('drawer-footer').append(close);
  }
  function setVersion(version) {
    currentVersion = version || releaseNotes[0].version;
    $('header-version').textContent = `v${currentVersion}`;
    $('release-notes').setAttribute('aria-label', `查看 ${currentVersion} 更新日志`);
  }
  $('release-notes').addEventListener('click', open);
  setVersion(currentVersion);
  return { setVersion };
}
