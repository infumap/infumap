// Capture a bounded, cleaned clone; do not click consent controls or mutate the
// live application. The raw snapshot, when requested, precedes all cleanup.
({limit, dump}) => {
  const liveNodes = [document.documentElement, ...document.documentElement.querySelectorAll('*')];
  if (liveNodes.length > 50000) return {oversized: true};
  const depths = new WeakMap();
  for (const node of liveNodes) {
    const depth = (depths.get(node.parentElement) || 0) + 1;
    if (depth > 200) return {oversized: true};
    depths.set(node, depth);
  }
  const raw = document.documentElement.outerHTML;
  if (new TextEncoder().encode(raw).length > limit) return {oversized: true};
  const root = document.documentElement.cloneNode(true);
  const originals = liveNodes;
  const copies = [root, ...root.querySelectorAll('*')];
  const original = new WeakMap(copies.map((node, index) => [node, originals[index]]));
  const vendor = /cookiebot|cybot|onetrust|optanon|trustarc|didomi|usercentrics|osano|klaro|axeptio|iubenda|termly|borlabs|complianz|cmplz|qc-cmp|sourcepoint|sp_message|cookieyes|cookiehub|cookiefirst|cookiescript|consentmanager|cookiecontrol|fc-consent-root/i;
  const generic = /cookie|consent|gdpr|ccpa/i;
  const name = node => `${node.tagName} ${node.getAttribute('id') || ''} ${node.getAttribute('class') || ''}`;
  const regions = [...root.querySelectorAll('main,[role="main"],article')];
  const headings = [...root.querySelectorAll('h1')].filter(node => {
    for (let parent = node; parent; parent = parent.parentElement) {
      if (vendor.test(name(parent)) || generic.test(name(parent))) return false;
    }
    return true;
  });
  const protectsContent = node => [...regions, ...headings].some(content =>
    node === content || node.contains(content) || content.contains(node));
  const overlay = node => {
    for (let parent = original.get(node); parent && parent !== document.body; parent = parent.parentElement) {
      if (parent.getAttribute('role') === 'dialog' || parent.getAttribute('aria-modal') === 'true') return true;
      if (['fixed', 'sticky', 'absolute'].includes(getComputedStyle(parent).position)) return true;
    }
    return false;
  };
  if (!/cookie|privacy|consent|gdpr|data-protection/i.test(location.pathname)) {
    for (const node of root.querySelectorAll('[id],[class]')) {
      if (!root.contains(node) || node.tagName === 'BODY' || protectsContent(node)) continue;
      if (vendor.test(name(node)) || (generic.test(name(node)) && overlay(node) && /cookie|consent/i.test(node.textContent || ''))) {
        node.remove();
      }
    }
  }
  const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  const title = (document.title || '').toLowerCase().trim();
  const heading = (root.querySelector('h1')?.textContent || '').toLowerCase().trim();
  let blocked = null;
  if (bodyText.length < 1600) {
    const text = bodyText.toLowerCase();
    const challenge = /^(just a moment|attention required|verify you are human|checking your browser)[.!…\s|:-]*(cloudflare)?/;
    if ((challenge.test(title) || challenge.test(heading)) && /verify|checking|security|javascript|cookies|human|blocked/.test(text)) {
      blocked = 'Site returned a browser verification challenge; no document text was extracted.';
    } else if (/^(access denied|403 forbidden)[.!\s]*$/.test(heading || title) && /permission to access|you have been blocked|you don.t have permission|reference #/.test(text)) {
      blocked = 'Site refused access to the document.';
    } else if (/^(404 not found|page not found)[.!\s]*$/.test(heading || title) && /requested|could not be found|does not exist/.test(text)) {
      blocked = 'Site returned a missing-document page.';
    }
  }
  for (const node of root.querySelectorAll('a[href],img[src]')) {
    const attribute = node.tagName === 'A' ? 'href' : 'src';
    try {
      const url = new URL(node.getAttribute(attribute), document.baseURI);
      const allowed = node.tagName === 'A' ? ['http:', 'https:', 'mailto:', 'tel:'] : ['http:', 'https:'];
      if (allowed.includes(url.protocol)) node.setAttribute(attribute, url.href);
      else if (node.tagName === 'IMG') node.replaceWith(document.createTextNode(node.getAttribute('alt') || ''));
      else node.removeAttribute(attribute);
    } catch (_) { node.removeAttribute(attribute); }
  }
  const html = root.outerHTML;
  if (new TextEncoder().encode(html).length > limit) return {oversized: true};
  return {oversized: false, url: location.href, html, raw: dump ? raw : null, blocked};
}
