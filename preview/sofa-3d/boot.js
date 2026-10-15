const response = await fetch('/theme/sections/sofa-3d.liquid');
const source = await response.text();
const css = source.match(/\{%\s*stylesheet\s*%\}([\s\S]*?)\{%\s*endstylesheet\s*%\}/);
const js = source.match(/\{%\s*javascript\s*%\}([\s\S]*?)\{%\s*endjavascript\s*%\}/);

if (!css || !js) {
  throw new Error('Kunde inte läsa sektionens CSS eller JavaScript.');
}

const style = document.createElement('style');
style.textContent = css[1];
document.head.appendChild(style);

const form = document.querySelector('form');
form.addEventListener(
  'submit',
  (event) => {
    event.preventDefault();
    const fabric = form.querySelector('[data-sofa-property="fabric"]').value;
    const color = form.querySelector('[data-sofa-property="color"]').value;
    document.querySelector('[data-preview-cart]').textContent = fabric && color ? `${fabric} / ${color}` : '';
  },
  true
);

const script = document.createElement('script');
script.textContent = js[1];
document.body.appendChild(script);
