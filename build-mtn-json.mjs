import fs from 'node:fs';
const model = JSON.parse(fs.readFileSync('E:\\Users\\maximus\\Documents\\GitHub\\uganda-art-pulse\\tools\\browser-use\\textarea-4--no-class-.txt', 'utf8'));

// Page background black
model.style.background = '#000000';

// Modify rectangle to be hero yellow background
const rect = model.children.find(c => c.id === 'shape-7ea89b92');
if (rect) {
  rect.style.background = '#FFCC00';
  rect.style.fill = '#FFCC00';
  rect.style.top = '0px';
  rect.style.left = '0px';
  rect.style.right = 'auto';
  rect.style.width = '100%';
  rect.style.height = '480px';
  rect.style.minHeight = '480px';
  rect.style.zIndex = '1';
}

// Modify text to MTN
const txt = model.children.find(c => c.id === 'text-3beab302');
if (txt) {
  txt.content = 'MTN';
  txt.style.color = '#000000';
  txt.style.fontSize = '120px';
  txt.style.fontWeight = '900';
  txt.style.left = '50%';
  txt.style.top = '120px';
  txt.style.transform = 'translateX(-50%)';
  txt.style.width = 'auto';
  txt.style.height = 'auto';
  txt.style.minHeight = 'auto';
  txt.style.whiteSpace = 'nowrap';
  txt.style.zIndex = '2';
}

// Add tagline text
const tagline = JSON.parse(JSON.stringify(txt));
tagline.id = 'text-tagline';
tagline.type = 'text';
tagline.tag = 'p';
tagline.name = 'Tagline';
tagline.content = 'Everywhere you go';
tagline.style.fontSize = '32px';
tagline.style.fontWeight = '600';
tagline.style.top = '260px';
tagline.style.zIndex = '2';
model.children.push(tagline);

// Add services section background
const servicesBg = {
  id: 'shape-services-bg', type: 'shape', tag: 'div', name: 'Services Background', content: '',
  props: { shapeKind: 'rectangle', originalShapeKind: 'rectangle', fillKind: '', authoredDomSharedStyleFields: { style: ['background'], responsiveStyle: {} } },
  style: { position: 'absolute', display: 'block', top: '480px', left: '0px', width: '100%', height: 'auto', minHeight: '420px', background: '#111111', fill: '#111111', stroke: 'none', border: '0', borderRadius: '0px', strokeWidth: '0', boxShadow: 'none', overflow: 'hidden', transform: '', zIndex: '1' },
  layout: { mode: 'manual', widthSizing: 'fixed', heightSizing: 'fixed', itemSpacing: '', padding: '', align: '', justify: '', role: 'overlay', positioning: 'overlay', source: 'studio', inferred: false },
  constraints: { horizontal: 'left', vertical: 'top' },
  effects: [], responsive: { mobile: {}, tablet: {}, desktop: {} }, locked: false, hidden: false, source: {}
};
model.children.push(servicesBg);

// Services title
const servicesTitle = {
  id: 'text-services-title', type: 'text', tag: 'h2', name: 'Services Title', content: 'Our Services',
  props: { authoredDomSharedStyleFields: { style: ['width','height','minHeight'], responsiveStyle: {} } },
  style: { position: 'absolute', display: 'block', left: '50%', top: '520px', transform: 'translateX(-50%)', width: 'auto', height: 'auto', minHeight: 'auto', color: '#FFCC00', fontSize: '36px', fontWeight: '700', lineHeight: '1.2', background: 'transparent', fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', letterSpacing: 'normal', border: '0', borderRadius: '0px', boxShadow: 'none', whiteSpace: 'nowrap', zIndex: '2' },
  layout: { mode: 'manual', widthSizing: 'fixed', heightSizing: 'fixed', itemSpacing: '', padding: '', align: '', justify: '', role: 'overlay', positioning: 'overlay', source: 'studio', inferred: false },
  constraints: { horizontal: 'left', vertical: 'top' },
  effects: [], responsive: { mobile: {}, tablet: {}, desktop: {} }, locked: false, hidden: false, source: {}
};
model.children.push(servicesTitle);

const services = [
  { title: 'Data', body: 'Fast 4G and 5G data bundles for everyone.', left: '120px' },
  { title: 'Voice', body: 'Affordable calls across all networks.', left: '440px' },
  { title: 'Mobile Money', body: 'Send, receive and pay securely with MoMo.', left: '760px' }
];
for (let i = 0; i < services.length; i++) {
  const s = services[i];
  const card = {
    id: `shape-service-${i}`, type: 'shape', tag: 'div', name: `${s.title} Card`, content: '',
    props: { shapeKind: 'rectangle', originalShapeKind: 'rectangle', fillKind: '', authoredDomSharedStyleFields: { style: ['background'], responsiveStyle: {} } },
    style: { position: 'absolute', display: 'block', top: '580px', left: s.left, width: '260px', height: '180px', minHeight: '180px', background: '#222222', fill: '#222222', stroke: 'none', border: '0', borderRadius: '16px', strokeWidth: '0', boxShadow: 'none', overflow: 'hidden', transform: '', zIndex: '1' },
    layout: { mode: 'manual', widthSizing: 'fixed', heightSizing: 'fixed', itemSpacing: '', padding: '', align: '', justify: '', role: 'overlay', positioning: 'overlay', source: 'studio', inferred: false },
    constraints: { horizontal: 'left', vertical: 'top' },
    effects: [], responsive: { mobile: {}, tablet: {}, desktop: {} }, locked: false, hidden: false, source: {}
  };
  const title = {
    id: `text-service-title-${i}`, type: 'text', tag: 'h3', name: `${s.title} Title`, content: s.title,
    props: { authoredDomSharedStyleFields: { style: ['width','height','minHeight'], responsiveStyle: {} } },
    style: { position: 'absolute', display: 'block', left: `${parseInt(s.left) + 24}px`, top: `${600}px`, width: '220px', height: 'auto', minHeight: 'auto', color: '#FFCC00', fontSize: '22px', fontWeight: '700', lineHeight: '1.3', background: 'transparent', fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', letterSpacing: 'normal', border: '0', borderRadius: '0px', boxShadow: 'none', whiteSpace: 'nowrap', zIndex: '2' },
    layout: { mode: 'manual', widthSizing: 'fixed', heightSizing: 'fixed', itemSpacing: '', padding: '', align: '', justify: '', role: 'overlay', positioning: 'overlay', source: 'studio', inferred: false },
    constraints: { horizontal: 'left', vertical: 'top' },
    effects: [], responsive: { mobile: {}, tablet: {}, desktop: {} }, locked: false, hidden: false, source: {}
  };
  const body = {
    id: `text-service-body-${i}`, type: 'text', tag: 'p', name: `${s.title} Body`, content: s.body,
    props: { authoredDomSharedStyleFields: { style: ['width','height','minHeight'], responsiveStyle: {} } },
    style: { position: 'absolute', display: 'block', left: `${parseInt(s.left) + 24}px`, top: '635px', width: '212px', height: 'auto', minHeight: 'auto', color: '#cccccc', fontSize: '15px', fontWeight: '400', lineHeight: '1.5', background: 'transparent', fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', letterSpacing: 'normal', border: '0', borderRadius: '0px', boxShadow: 'none', whiteSpace: 'normal', zIndex: '2' },
    layout: { mode: 'manual', widthSizing: 'fixed', heightSizing: 'fixed', itemSpacing: '', padding: '', align: '', justify: '', role: 'overlay', positioning: 'overlay', source: 'studio', inferred: false },
    constraints: { horizontal: 'left', vertical: 'top' },
    effects: [], responsive: { mobile: {}, tablet: {}, desktop: {} }, locked: false, hidden: false, source: {}
  };
  model.children.push(card, title, body);
}

// Footer
const footerBg = {
  id: 'shape-footer', type: 'shape', tag: 'div', name: 'Footer', content: '',
  props: { shapeKind: 'rectangle', originalShapeKind: 'rectangle', fillKind: '', authoredDomSharedStyleFields: { style: ['background'], responsiveStyle: {} } },
  style: { position: 'absolute', display: 'block', top: '860px', left: '0px', width: '100%', height: '80px', minHeight: '80px', background: '#000000', fill: '#000000', stroke: 'none', border: '0', borderRadius: '0px', strokeWidth: '0', boxShadow: 'none', overflow: 'hidden', transform: '', zIndex: '1' },
  layout: { mode: 'manual', widthSizing: 'fixed', heightSizing: 'fixed', itemSpacing: '', padding: '', align: '', justify: '', role: 'overlay', positioning: 'overlay', source: 'studio', inferred: false },
  constraints: { horizontal: 'left', vertical: 'top' },
  effects: [], responsive: { mobile: {}, tablet: {}, desktop: {} }, locked: false, hidden: false, source: {}
};
const footerText = {
  id: 'text-footer', type: 'text', tag: 'p', name: 'Footer Text', content: '© 2026 MTN. Together we are unstoppable.',
  props: { authoredDomSharedStyleFields: { style: ['width','height','minHeight'], responsiveStyle: {} } },
  style: { position: 'absolute', display: 'block', left: '50%', top: '890px', transform: 'translateX(-50%)', width: 'auto', height: 'auto', minHeight: 'auto', color: '#888888', fontSize: '14px', fontWeight: '400', lineHeight: '1.5', background: 'transparent', fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', letterSpacing: 'normal', border: '0', borderRadius: '0px', boxShadow: 'none', whiteSpace: 'nowrap', zIndex: '2' },
  layout: { mode: 'manual', widthSizing: 'fixed', heightSizing: 'fixed', itemSpacing: '', padding: '', align: '', justify: '', role: 'overlay', positioning: 'overlay', source: 'studio', inferred: false },
  constraints: { horizontal: 'left', vertical: 'top' },
  effects: [], responsive: { mobile: {}, tablet: {}, desktop: {} }, locked: false, hidden: false, source: {}
};
model.children.push(footerBg, footerText);

// Update page height
model.style.minHeight = '940px';
model.props.lordeProject.pages[0].height = 940;
model.props.lordeProject.pages[0].layerRefs = model.children.map(c => c.id);

const out = JSON.stringify(model);
fs.writeFileSync('E:\\Users\\maximus\\Documents\\GitHub\\uganda-art-pulse\\tools\\browser-use\\mtn-page-model.json', out);
console.log('wrote', out.length);
