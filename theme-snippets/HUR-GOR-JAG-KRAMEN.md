# KRAMEN först + skugga + 4 färgcirklar

## Varför du ser 1 cirkel + "+8" nu

Snippeten `sofa-grupp-dots` är live, men **bara KRAMEN** har taggen `soffa-grupp`.
Det finns inga andra färgprodukter att rita prickar för.
`farg-total:12` gör att "+8" räknas fram (12 − 4), även om bara 1 prick finns.

---

## 1) Få 4 cirklar (taggar i Admin)

### A. Huvudprodukten (KRAMEN – den som syns i rutnätet)
Taggar (har du redan):
- `soffa-grupp`
- `soffa-huvud`
- `farg-total:12` (valfritt, styr +N)

### B. Skapa/tagga minst 3 andra färgprodukter
Varje färg = **egen produkt** (inte variant), med taggar:
- `soffa-grupp`
- `dolj-i-rutnat`   ← döljer dem som egna kort
- `farg:Beige`      ← byt namn per färg, t.ex. `farg:Blå`, `farg:Grå`

**Prickbilden** = produktens **huvudbild**. Sätt en tydlig tyg-/färgruta som featured image.

### C. Lägg dem i samma collection som snippeten läser
Snippeten söker först `soffgrupp`, annars `alla-soffor`.

Rekommenderat:
1. Skapa collection med handle **`soffgrupp`**
2. Lägg i den: KRAMEN + alla färgprodukter (minst 4)
3. Publicera collectionen (kan vara dold från menyn)

Utan detta hittar koden bara KRAMEN → 1 cirkel.

---

## 2) KRAMEN först i rutnätet

Taggen `soffa-huvud` räcker **inte** ensam — collection-loopen måste flytta kortet.

I `sections/main-collection-product-grid.liquid`, i `{%- for product in collection.products -%}`:

1. Direkt efter `for`, före `<li>`:
```liquid
  {% if product.tags contains 'dolj-i-rutnat' %}
    {% continue %}
  {% endif %}
```

2. På `<li>`: lägg class + `order: -1` för `soffa-huvud`
   (se `theme-snippets/main-collection-grid-patch.liquid`)

3. Lägg CSS en gång i samma fil:
```html
<style>
  #product-grid .grid__item--sofa-first { order: -1; }
</style>
```

---

## 3) Skugga / “ny soffa”-känsla

Se till att `snippets/card-product.liquid` har:
- sofa-featured-klasserna
- `{% render 'sofa-grupp-dots', product: card_product %}` efter priset
- skugg-CSS för `.product-card-wrapper--sofa-featured`

Referensfil: `theme-snippets/card-product.liquid`

---

## Snabbchecklista

| Steg | Klart när |
|------|-----------|
| 4+ produkter med `soffa-grupp` | 4 cirklar syns |
| Färger har `dolj-i-rutnat` | De syns inte som egna kort |
| Collection `soffgrupp` (eller alla i `alla-soffor`) | Snippeten hittar syskon |
| Grid-patch med `order: -1` | KRAMEN är först |
| card-product med skugg-CSS | Kortet ser “featured” ut |
