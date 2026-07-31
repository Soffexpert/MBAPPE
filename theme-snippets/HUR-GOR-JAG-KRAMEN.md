# Färgcirklar med egna bilder (Innehåll → Filer)

## Gör så här

1. **Shopify Admin → Innehåll → Filer** → ladda upp tyg-/färgrutor (png/jpg).
2. Klicka filen → **kopiera länken** (`https://cdn.shopify.com/s/files/...`).
3. Öppna **KRAMEN** (huvudprodukten) → Taggar → lägg till:

```
soffa-grupp
soffa-huvud
farg-total:12
prick-bild:https://cdn.shopify.com/s/files/.../beige.png
prick-bild:https://cdn.shopify.com/s/files/.../bla.png|Blå
prick-bild:https://cdn.shopify.com/s/files/.../gra.png|Grå
prick-bild:https://cdn.shopify.com/s/files/.../gron.png|Grön
```

Format:
- `prick-bild:URL`
- eller `prick-bild:URL|Färgnamn`

Ingen mellanslag mellan `prick-bild:` och `https`.

4. Klistra in senaste `snippets/sofa-grupp-dots.liquid` från:
   `theme-snippets/sofa-grupp-dots.liquid`

Max **4** prickar visas. Har du `farg-total:12` visas `+8` efter fyra prickar.

Du behöver **inte** Active färgprodukter för detta läge — bara fillänkar på huvudprodukten.
