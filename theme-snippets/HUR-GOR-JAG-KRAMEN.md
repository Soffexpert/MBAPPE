# KRAMEN först + skugga + 4 färgcirklar

## Arkiverade produkter syns INTE som prickar

Shopify visar **inte** arkiverade eller utkast-produkter i Liquid på butiken.
Taggen `farg:Beige` på en arkiverad produkt gör **ingenting** för cirklarna.

Färgprodukterna måste vara:

1. **Active** (aktiv / publicerad till Online Store)
2. Tagade: `soffa-grupp` + `dolj-i-rutnat` + `farg:Beige` (osv.)
3. Medlemmar i collection **`soffgrupp`** (eller `alla-soffor`)

`dolj-i-rutnat` + grid-patchen gör att de **inte** blir egna kort i rutnätet —
men de finns kvar så att huvudprodukten kan läsa dem som prickar.

---

## Gör så här (rätt ordning)

### 1. Grid-patch först (annars syns färgerna som kort)
I `sections/main-collection-product-grid.liquid`, direkt i for-loopen:

```liquid
{% if product.tags contains 'dolj-i-rutnat' %}
  {% continue %}
{% endif %}
```

(Se `main-collection-grid-patch.liquid` för förstaplats + `order: -1`.)

### 2. Avarkivera färgprodukterna → Active
Admin → Produkter → öppna varje färg → status **Active**.

### 3. Taggar per färgprodukt
- `soffa-grupp`
- `dolj-i-rutnat`
- `farg:Beige` (byt till rätt färgnamn)

Huvudprodukt (KRAMEN):
- `soffa-grupp`
- `soffa-huvud`
- `farg-total:12` (valfritt)

### 4. Collection `soffgrupp`
Skapa collection med handle **`soffgrupp`**, lägg i:
- KRAMEN
- alla Active färgprodukter

Kan vara dold från menyn — handle måste vara exakt `soffgrupp`.

### 5. Huvudbild = prickbild
Sätt en tydlig tyg-/färgruta som **huvudbild** på varje färgprodukt.

### 6. Uppdatera snippet
Klistra in senaste `theme-snippets/sofa-grupp-dots.liquid` → `snippets/sofa-grupp-dots.liquid`.

---

## Snabbchecklista

| Steg | Klart när |
|------|-----------|
| Färger = **Active** (inte arkiverade) | Liquid kan läsa dem |
| Taggar `soffa-grupp` + `dolj-i-rutnat` + `farg:…` | Rätt grupp + dolda i grid |
| I collection `soffgrupp` | Snippeten hittar syskon |
| Grid `{% continue %}` för `dolj-i-rutnat` | Inga extra kort i rutnätet |
| 4+ Active med `soffa-grupp` | 4 cirklar under KRAMEN |
