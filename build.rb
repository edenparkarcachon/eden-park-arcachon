#!/usr/bin/env ruby
# encoding: utf-8
#
# Générateur du site Eden Park Arcachon.
#
#   ruby build.rb
#
# Lit data/site.json et data/products.json, assemble les gabarits de src/
# et écrit le site statique complet dans dist/ (prêt à déployer sur Netlify).

Encoding.default_external = Encoding::UTF_8
Encoding.default_internal = Encoding::UTF_8

require "erb"
require "json"
require "fileutils"
require "cgi"
require "date"
require "digest"

ROOT = File.expand_path(__dir__)
SRC  = File.join(ROOT, "src")
DIST = File.join(ROOT, "dist")

SITE    = JSON.parse(File.read(File.join(ROOT, "data/site.json")))
CATALOG = JSON.parse(File.read(File.join(ROOT, "data/products.json")))
CATS     = CATALOG["categories"]
PRODUCTS = CATALOG["products"]
TODAY    = Date.today.iso8601
# Stock synchronisé depuis l'admin (scripts/sync-catalog.mjs) ; absent en local
STOCK_FILE = File.join(ROOT, "data/stock.json")
STOCK = File.exist?(STOCK_FILE) ? JSON.parse(File.read(STOCK_FILE)) : {}
# Avis clients publiés (modérés dans l'admin), par produit
REVIEWS_FILE = File.join(ROOT, "data/reviews.json")
REVIEWS = File.exist?(REVIEWS_FILE) ? JSON.parse(File.read(REVIEWS_FILE)) : {}
# Soldes et promotions : réductions calculées par scripts/sync-catalog.mjs (netlify/lib/pricing.mjs)
PRICING_FILE = File.join(ROOT, "data/pricing.json")
PRICING = File.exist?(PRICING_FILE) ? JSON.parse(File.read(PRICING_FILE)) : {}
SALES_FILE = File.join(ROOT, "data/sales.json")
SALES = File.exist?(SALES_FILE) ? JSON.parse(File.read(SALES_FILE)) : { "campaigns" => [] }
BUILD_DATE = begin
  ENV["TZ"] = "Europe/Paris"
  Time.now.strftime("%Y-%m-%d")
end
# Textes et photos des pages (modifiables depuis l'admin, onglet Pages & photos)
CONTENT = JSON.parse(File.read(File.join(ROOT, "data/content.json")))

# Champs dérivés des réglages saisis dans l'admin
def fmt_time(t)
  hh, mm = t.split(":")
  mm == "00" ? "#{hh.to_i}h" : "#{hh.to_i}h#{mm}"
end

def slots_label(row)
  return row["slots"] if row["opens"].nil? || row["opens"].empty?
  row["opens"].each_with_index.map { |o, i| "#{fmt_time(o)} – #{fmt_time(row['closes'][i])}" }.join(" · ")
end

def phone_intl(phone)
  digits = phone.to_s.gsub(/\D/, "")
  digits.start_with?("0") ? "+33#{digits[1..-1]}" : "+#{digits}"
end

SITE["phone_intl"] = phone_intl(SITE["phone"])
SITE["google_maps"] = "https://www.google.com/maps/search/?api=1&query=" +
  CGI.escape("Eden Park #{SITE['address']['street']} #{SITE['address']['postal_code']} #{SITE['address']['city']}")

# ---------------------------------------------------------------------------
# Utilitaires
# ---------------------------------------------------------------------------

def h(s)
  # typographie française : espaces insécables dans les guillemets « … »
  CGI.escapeHTML(s.to_s).gsub("« ", "« ").gsub(" »", " »")
end

def abs_url(path)
  SITE["url"] + path
end

def euro(cents)
  whole, dec = (cents.to_i).divmod(100)
  str = whole.to_s.reverse.scan(/\d{1,3}/).join(" ").reverse
  dec.zero? ? "#{str} €" : "#{str},#{format('%02d', dec)} €"
end

def euro_plain(cents)
  format("%.2f", cents.to_i / 100.0)
end

def cat_by_slug(slug)
  CATS.find { |c| c["slug"] == slug }
end

# Catégories affichées dans les menus et sur l'accueil : celles qui ont au moins un produit
def shop_cats
  CATS.select { |c| PRODUCTS.any? { |p| p["category"] == c["slug"] } }
end

def product_url(p)
  "/produit/#{p['slug']}/"
end

def category_url(c)
  "/boutique/#{c['slug']}/"
end

# Dimensions d'un JPEG (lecture du segment SOF), sans dépendance externe.
def jpeg_size(path)
  File.open(path, "rb") do |f|
    return nil unless f.read(2) == "\xFF\xD8".b
    loop do
      marker = f.read(2)
      return nil if marker.nil? || marker.bytesize < 2
      m = marker.bytes[1]
      len = f.read(2).unpack1("n")
      if [0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF].include?(m)
        f.read(1)
        hgt, wid = f.read(4).unpack("nn")
        return [wid, hgt]
      end
      f.seek(len - 2, IO::SEEK_CUR)
    end
  end
end

ASSET_VERSION = Digest::MD5.hexdigest(
  Dir[File.join(SRC, "assets/{css,js}/*")].sort.map { |f| File.read(f) }.join + JSON.dump([CATALOG, SITE, STOCK])
)[0, 8]

def asset(path)
  "/assets/#{path}?v=#{ASSET_VERSION}"
end

# ---------------------------------------------------------------------------
# Visuels provisoires (SVG) pour les produits sans photo
# ---------------------------------------------------------------------------

def light?(hex)
  r, g, b = hex.delete("#").scan(/../).map { |x| x.to_i(16) }
  (0.299 * r + 0.587 * g + 0.114 * b) > 150
end

def placeholder_svg(type, color, mark = "dune")
  stroke = light?(color) ? "#c9c0b1" : "none"
  ink    = light?(color) ? "#16213d" : "#ffffff"
  body = case type
         when "sweat"
           %(<path d="M95 70 L127 56 Q150 72 173 56 L205 70 L240 98 L264 262 L236 268 L205 150 L205 332 L95 332 L95 150 L64 268 L36 262 L60 98 Z" fill="#{color}" stroke="#{stroke}" stroke-width="1.5" stroke-linejoin="round"/>
             <path d="M127 56 Q150 80 173 56" fill="none" stroke="#{ink}" stroke-opacity=".25" stroke-width="2"/>
             <rect x="95" y="318" width="110" height="14" fill="#{ink}" fill-opacity=".08"/>)
         else
           %(<path d="M95 66 L127 52 Q150 70 173 52 L205 66 L252 100 L232 142 L205 128 L205 332 L95 332 L95 128 L68 142 L48 100 Z" fill="#{color}" stroke="#{stroke}" stroke-width="1.5" stroke-linejoin="round"/>
             <path d="M127 52 Q150 78 173 52" fill="none" stroke="#{ink}" stroke-opacity=".25" stroke-width="2"/>)
         end
  emb = if mark == "whale"
          %(<g transform="translate(163 112) scale(.55)" fill="#f3b9cb" stroke="#{ink}" stroke-width="1.2"><path d="M20 34 V20 C14 12 6 11 0 4 C6 14 13 19 20 21 C27 19 34 14 40 4 C34 11 26 12 20 20 Z"/></g>)
        else
          %(<path d="M160 128 C166 124 170 114 177 113 C182 112 186 120 192 126" fill="none" stroke="#f3b9cb" stroke-width="2.2" stroke-linecap="round"/>
            <text x="176" y="138" text-anchor="middle" font-family="Georgia, serif" font-style="italic" font-size="7.5" fill="#{ink}">Bassin d'Arcachon</text>)
        end
  <<~SVG
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400" role="img" class="ph">
      <rect width="300" height="400" fill="#f1ebe1"/>
      <ellipse cx="150" cy="352" rx="92" ry="7" fill="#16213d" fill-opacity=".06"/>
      #{body}
      #{emb}
      <text x="150" y="382" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="9" letter-spacing="2" fill="#16213d" fill-opacity=".45">VISUEL PROVISOIRE</text>
    </svg>
  SVG
end

# Normalise une image produit : chemin publié, dimensions, texte alternatif.
def image_info(img, product = nil, index = 0)
  if img["placeholder"]
    file = "produits/ph-#{product['slug']}-#{index + 1}.svg"
    { "src" => "/assets/img/#{file}", "src720" => nil, "w" => 300, "h" => 400, "alt" => img["alt"],
      "svg" => placeholder_svg(img["placeholder"], img["color"], img["mark"] || "dune"),
      "file" => file, "variant" => img["variant"] || color_name_for(product, img["color"]), "placeholder" => true }
  else
    full = File.join(SRC, "assets/img", img["src"])
    w, hh = jpeg_size(full) || [1050, 1400]
    small = img["src"].sub(/\.jpg\z/, "-720.jpg")
    has_small = File.exist?(File.join(SRC, "assets/img", small))
    { "src" => "/assets/img/#{img['src']}", "src720" => (has_small ? "/assets/img/#{small}" : nil),
      "w" => w, "h" => hh, "alt" => img["alt"], "variant" => img["variant"], "placeholder" => false }
  end
end

def color_name_for(product, hex)
  return nil unless product && hex
  c = product["colors"].find { |col| col["hex"].casecmp(hex).zero? }
  c && c["name"]
end

def product_images(p)
  p["images"].each_with_index.map { |img, i| image_info(img, p, i) }
end

# Sur Netlify, les photos passent par le service d'images (Netlify Image CDN) : format moderne
# (AVIF/WebP selon le navigateur) et largeur adaptée à l'écran. En local, JPEG d'origine.
IMAGE_CDN = ENV["NETLIFY"] == "true"
CDN_WIDTHS = [360, 540, 720, 1080, 1440].freeze

def cdn(src, width)
  "/.netlify/images?url=#{CGI.escape(src)}&amp;w=#{width}&amp;q=76"
end

def img_tag(info, sizes: "(max-width: 760px) 50vw, 25vw", cls: nil, loading: "lazy", priority: false, alt: nil)
  a = h(alt.nil? ? info["alt"] : alt)
  c = cls ? %( class="#{cls}") : ""
  load = priority ? %( fetchpriority="high") : %( loading="#{loading}")
  if IMAGE_CDN && info["src"].end_with?(".jpg")
    widths = CDN_WIDTHS.select { |w| w < info["w"] } + [info["w"]]
    srcset = widths.map { |w| "#{cdn(info['src'], w)} #{w}w" }.join(", ")
    return %(<img src="#{cdn(info['src'], [720, info['w']].min)}" srcset="#{srcset}" sizes="#{sizes}" width="#{info['w']}" height="#{info['h']}" alt="#{a}"#{c}#{load} decoding="async">)
  end
  if info["src720"]
    small_w = (info["w"] * 720.0 / [info["w"], info["h"]].max).round
    %(<img src="#{info['src']}" srcset="#{info['src720']} #{small_w}w, #{info['src']} #{info['w']}w" sizes="#{sizes}" width="#{info['w']}" height="#{info['h']}" alt="#{a}"#{c}#{load} decoding="async">)
  else
    %(<img src="#{info['src']}" width="#{info['w']}" height="#{info['h']}" alt="#{a}"#{c}#{load} decoding="async">)
  end
end

def simple_img(path, alt, sizes: "100vw", cls: nil, priority: false)
  img_tag(image_info({ "src" => path, "alt" => alt }), sizes: sizes, cls: cls, priority: priority)
end

# Photo issue de data/content.json : { "src": "...", "alt": "..." }
def content_img(obj, sizes: "100vw", priority: false)
  return "" if obj.nil? || obj["src"].to_s.empty?
  simple_img(obj["src"], obj["alt"].to_s, sizes: sizes, priority: priority)
end

# Photo d'une catégorie : celle choisie dans l'admin, sinon la 1re photo d'un de ses produits
def category_image(c)
  return image_info({ "src" => c["image"], "alt" => "" }) unless c["image"].to_s.empty?
  p = PRODUCTS.find { |x| x["category"] == c["slug"] && !x["images"].empty? }
  p && product_images(p).first
end

# « Mots magiques » utilisables dans les textes de l'admin (FAQ, bandeau…),
# remplacés par les valeurs des Réglages
def tokens(text)
  s = SITE["shipping"]
  map = {
    "telephone" => SITE["phone"], "email" => SITE["email"],
    "prix_livraison" => euro(s["metro_price"]), "livraison_offerte" => euro(s["free_threshold"]),
    "prix_domtom" => euro(s["domtom_price"]), "delai_france" => s["metro_delay"], "delai_domtom" => s["domtom_delay"],
    "delai_retour" => SITE["return_days"].to_s, "delai_sur_commande" => (s["backorder_days"] || 15).to_s
  }
  text.to_s.gsub(/\{([a-z_]+)\}/) { map.key?($1) ? map[$1].to_s : $& }
end

def slugify(s)
  s.to_s.unicode_normalize(:nfd).gsub(/\p{Mn}/, "").downcase.gsub(/[^a-z0-9]+/, "-").gsub(/\A-|-\z/, "")
end

# Mise en forme simple des articles du Journal (saisis dans l'admin) :
#   ligne vide = nouveau paragraphe, « ## » = intertitre, « - » = liste,
#   **gras**, [texte du lien](/page/ ou https://…)
def inline_md(str)
  h(str)
    .gsub(/\*\*(.+?)\*\*/) { "<strong>#{$1}</strong>" }
    .gsub(/\[([^\]]+)\]\((\/[^\s)]*|https:\/\/[^\s)]+)\)/) do
      ext = $2.start_with?("https://") ? %( target="_blank" rel="noopener") : ""
      %(<a href="#{$2}"#{ext}>#{$1}</a>)
    end
end

def rich_text(text)
  tokens(text).split(/\n\s*\n/).map do |block|
    lines = block.strip.split("\n").map(&:strip)
    if lines.first.to_s.start_with?("## ")
      "<h2>#{inline_md(lines.first[3..-1])}</h2>" + (lines.size > 1 ? "<p>#{lines[1..-1].map { |l| inline_md(l) }.join('<br>')}</p>" : "")
    elsif lines.all? { |l| l.start_with?("- ") }
      "<ul>#{lines.map { |l| "<li>#{inline_md(l[2..-1])}</li>" }.join}</ul>"
    else
      "<p>#{lines.map { |l| inline_md(l) }.join('<br>')}</p>"
    end
  end.join("\n")
end

def journal_articles
  (CONTENT["journal"] || []).select { |a| a["published"] != false && !a["slug"].to_s.empty? }.sort_by { |a| a["date"].to_s }.reverse
end

def article_url(a)
  "/journal/#{a['slug']}/"
end

def date_fr(iso)
  mois = %w[janvier février mars avril mai juin juillet août septembre octobre novembre décembre]
  d = Date.parse(iso.to_s) rescue nil
  d ? "#{d.day} #{mois[d.month - 1]} #{d.year}" : ""
end

def paragraphs(text)
  text.to_s.split(/\n\s*\n/).map { |para| "<p>#{h(para.strip)}</p>" }.join("\n")
end

def osm_embed
  lat = SITE["geo"]["lat"].to_f
  lng = SITE["geo"]["lng"].to_f
  "https://www.openstreetmap.org/export/embed.html?bbox=#{lng - 0.006}%2C#{lat - 0.003}%2C#{lng + 0.006}%2C#{lat + 0.003}&amp;layer=mapnik&amp;marker=#{lat}%2C#{lng}"
end

# ---------------------------------------------------------------------------
# Icônes
# ---------------------------------------------------------------------------

ICONS = {
  "bag" => '<path d="M5 8h14l-1 12H6L5 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  "menu" => '<path d="M3 7h18M3 12h18M3 17h18"/>',
  "close" => '<path d="M6 6l12 12M18 6L6 18"/>',
  "truck" => '<path d="M2 6h11v10H2zM13 10h4l3 3v3h-7z"/><circle cx="6" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
  "store" => '<path d="M3 9l1.5-5h15L21 9"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M5 12v8h14v-8M10 20v-5h4v5"/>',
  "return" => '<path d="M4 9h11a5 5 0 0 1 0 10H8"/><path d="M8 5L4 9l4 4"/>',
  "lock" => '<rect x="5" y="10" width="14" height="10" rx="1.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  "pin" => '<path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  "clock" => '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  "phone" => '<path d="M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2z"/>',
  "mail" => '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 7l9 6 9-6"/>',
  "check" => '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  "arrow" => '<path d="M4 12h15M13 6l6 6-6 6"/>',
  "needle" => '<path d="M4 20L17 7"/><path d="M15 5l4 4"/><circle cx="18.5" cy="5.5" r="1.2"/><path d="M4 20c2-4 5-5 8-4"/>',
  "ruler" => '<rect x="2" y="8" width="20" height="8" rx="1"/><path d="M6 8v3M10 8v4M14 8v3M18 8v4"/>',
  "search" => %q(<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.3-4.3"/>),
  "filter" => '<path d="M4 6h16M7 12h10M10 18h4"/>',
  "gift" => '<rect x="3" y="8" width="18" height="4"/><path d="M5 12v8h14v-8M12 8v12"/><path d="M12 8S10 3 7.5 4.5 9 8 12 8zM12 8s2-5 4.5-3.5S15 8 12 8z"/>',
  "instagram" => '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".8" fill="currentColor"/>',
  "facebook" => '<path d="M14 8h3V4h-3a4 4 0 0 0-4 4v2H7v4h3v7h4v-7h3l1-4h-4V8.5c0-.3.2-.5.5-.5z"/>',
  "chat" => '<path d="M4 5h16v11H9l-5 4z"/>'
}.freeze

def icon(name, cls: nil)
  c = cls ? %( class="#{cls}") : ""
  %(<svg#{c} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">#{ICONS.fetch(name)}</svg>)
end

# Nœud papillon officiel, découpé tel quel dans le logo fourni par la marque.
def bow(cls: "logo__bow")
  %(<img class="#{cls}" src="/assets/img/noeud-eden-park.png" width="160" height="66" alt="" aria-hidden="true">)
end

# Mesure d'audience : active seulement si un vrai identifiant Google Analytics est renseigné
def analytics_on?
  SITE["analytics_id"].to_s.match?(/\AG-[A-Z0-9]{4,}\z/) && !SITE["analytics_id"].include?("XXXX")
end

# Médiateur de la consommation (formule neutre tant qu'aucun médiateur n'est désigné)
def mediator_text
  m = SITE["legal"]["mediator"].to_s.strip
  m.empty? ? "le médiateur de la consommation désigné par le Vendeur, dont les coordonnées sont communiquées au Client sur simple demande" : m
end

# Logo officiel Eden Park Paris, reproduit sans modification (annexe 5, § 4.1).
def logo(variant: :bleu)
  file = variant == :blanc ? "logo-eden-park-blanc.png" : "logo-eden-park.png"
  %(<a class="logo" href="/" aria-label="Eden Park Arcachon – accueil"><img class="logo__img" src="/assets/img/#{file}" width="720" height="162" alt="Eden Park Paris"><span class="logo__sub">Boutique d'Arcachon</span></a>)
end

EMBLEMS = {
  "dune" => '<svg viewBox="0 0 64 40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2 34c10-2 16-20 28-24 8-2.6 14 8 32 24"/><path d="M14 34c6-1 10-6 16-6s10 4 18 6" stroke="#e79ab3"/></svg>',
  "whale" => '<svg viewBox="0 0 64 40" aria-hidden="true"><path d="M32 38V22C26 14 15 13 7 4c5 11 14 17 25 20 11-3 20-9 25-20-8 9-19 10-25 18z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M4 38h56" stroke="#e79ab3" stroke-width="1.6" stroke-linecap="round"/></svg>',
  "pine" => '<svg viewBox="0 0 64 40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 16c0-6 8-9 14-7 3-4 12-4 15 0 6-1 11 3 9 8-2 3-8 4-12 2-4 3-11 3-15 0-5 2-11 1-11-3z"/><path d="M33 19v19M33 26l-5-5M33 24l6-4"/><path d="M8 38h48" stroke="#e79ab3"/></svg>'
}.freeze

# ---------------------------------------------------------------------------
# Données structurées (schema.org)
# ---------------------------------------------------------------------------

def store_schema
  {
    "@context" => "https://schema.org",
    "@type" => "ClothingStore",
    "@id" => abs_url("/#boutique"),
    "name" => SITE["name"],
    "alternateName" => "Eden Park Boutique Arcachon",
    "description" => SITE["description"],
    "url" => abs_url("/"),
    "image" => [abs_url("/assets/img/boutique/boutique-eden-park-arcachon-interieur.jpg"), abs_url("/assets/img/boutique/boutique-eden-park-arcachon-equipe.jpg")],
    "logo" => abs_url("/assets/img/logo-eden-park-arcachon.png"),
    "telephone" => SITE["phone_intl"],
    "email" => SITE["email"],
    "priceRange" => "€€",
    "currenciesAccepted" => "EUR",
    "paymentAccepted" => "Carte bancaire, Espèces",
    "brand" => { "@type" => "Brand", "name" => "Eden Park" },
    "address" => {
      "@type" => "PostalAddress",
      "streetAddress" => SITE["address"]["street"],
      "postalCode" => SITE["address"]["postal_code"],
      "addressLocality" => SITE["address"]["city"],
      "addressRegion" => SITE["address"]["region"],
      "addressCountry" => SITE["address"]["country"]
    },
    "geo" => { "@type" => "GeoCoordinates", "latitude" => SITE["geo"]["lat"], "longitude" => SITE["geo"]["lng"] },
    "hasMap" => SITE["google_maps"],
    "openingHoursSpecification" => SITE["hours"].flat_map do |row|
      row["opens"].each_with_index.map do |o, i|
        { "@type" => "OpeningHoursSpecification", "dayOfWeek" => row["schema_days"], "opens" => o, "closes" => row["closes"][i] }
      end
    end,
    "sameAs" => SITE["social"].values,
    "areaServed" => ["Arcachon", "Bassin d'Arcachon", "La Teste-de-Buch", "Pyla-sur-Mer", "Gujan-Mestras", "Lège-Cap-Ferret", "Andernos-les-Bains", "France"]
  }
end

def website_schema
  { "@context" => "https://schema.org", "@type" => "WebSite", "name" => SITE["name"], "url" => abs_url("/"), "inLanguage" => "fr-FR",
    "potentialAction" => { "@type" => "SearchAction", "target" => { "@type" => "EntryPoint", "urlTemplate" => abs_url("/recherche/?q=") + "{search_term_string}" }, "query-input" => "required name=search_term_string" },
    "publisher" => { "@id" => abs_url("/#boutique") } }
end

def breadcrumb_schema(items)
  { "@context" => "https://schema.org", "@type" => "BreadcrumbList",
    "itemListElement" => items.each_with_index.map { |(name, path), i| { "@type" => "ListItem", "position" => i + 1, "name" => name, "item" => abs_url(path) } } }
end

def shipping_details
  s = SITE["shipping"]
  [
    { "@type" => "OfferShippingDetails",
      "shippingRate" => { "@type" => "MonetaryAmount", "value" => euro_plain(s["metro_price"]), "currency" => "EUR" },
      "shippingDestination" => { "@type" => "DefinedRegion", "addressCountry" => "FR" },
      "deliveryTime" => { "@type" => "ShippingDeliveryTime",
                          "handlingTime" => { "@type" => "QuantitativeValue", "minValue" => 0, "maxValue" => 2, "unitCode" => "DAY" },
                          "transitTime" => { "@type" => "QuantitativeValue", "minValue" => 2, "maxValue" => 4, "unitCode" => "DAY" } } }
  ]
end

def return_policy
  { "@type" => "MerchantReturnPolicy", "applicableCountry" => "FR",
    "returnPolicyCategory" => "https://schema.org/MerchantReturnFiniteReturnWindow",
    "merchantReturnDays" => SITE["return_days"], "returnMethod" => ["https://schema.org/ReturnByMail", "https://schema.org/ReturnInStore"],
    "returnFees" => "https://schema.org/FreeReturn" }
end

# ---------------------------------------------------------------------------
# Soldes et promotions (même logique que netlify/lib/pricing.mjs et main.js)
# ---------------------------------------------------------------------------

def active_offer(p, date = BUILD_DATE)
  (PRICING[p["slug"]] || [])
    .select { |o| (o["starts"].to_s.empty? || date >= o["starts"]) && (o["ends"].to_s.empty? || date <= o["ends"]) && o["price"] < p["price"] }
    .min_by { |o| o["price"] }
end

def effective_price(p)
  (o = active_offer(p)) ? o["price"] : p["price"]
end

def on_sale_products
  PRODUCTS.select { |p| active_offer(p) }
end

def sale_badge_text(o)
  o["percent"].to_i > 0 ? "-#{o['percent']} %" : o["label"]
end

# Prix affiché (carte produit ou fiche) ; recalculé par main.js à la date du jour
def price_html(p, style)
  o = active_offer(p)
  inner = if o
            ref = o["ref"] ? %( <del>#{euro(o['ref'])}</del>) : ""
            badge = style == "page" ? %( <span class="badge badge--sale">#{h(o['ref'] ? sale_badge_text(o) : o['label'])}</span>) : ""
            %(<ins>#{euro(o['price'])}</ins>#{ref}#{badge})
          else
            euro(p["price"])
          end
  tag = style == "page" ? "p" : "span"
  cls = style == "page" ? "pinfo__price" : "price"
  %(<#{tag} class="#{cls}" data-price-slug="#{p['slug']}" data-price-style="#{style}">#{inner}</#{tag}>)
end

def sale_note(o)
  return "" unless o
  parts = []
  parts << "#{o['label']} : le prix barré est le prix le plus bas pratiqué au cours des 30 jours précédant la réduction." if o["ref"]
  parts << "Offre valable jusqu'au #{date_fr(o['ends'])} inclus." unless o["ends"].to_s.empty?
  parts.join(" ")
end

# Messages des campagnes en cours pour le bandeau du haut
def campaign_banners(date = BUILD_DATE)
  (SALES["campaigns"] || []).select { |c| c["active"] && !c["banner"].to_s.empty? && date >= c["starts"].to_s && date <= c["ends"].to_s }.map { |c| c["banner"] }
end

# « Complétez le look » : produits choisis dans l'admin, sinon produits d'autres catégories
def look_for(p, max = 3)
  chosen = (p["related"] || []).map { |slug| PRODUCTS.find { |x| x["slug"] == slug } }.compact
  auto = PRODUCTS.reject { |x| x["slug"] == p["slug"] || x["category"] == p["category"] || chosen.include?(x) }
                 .sort_by { |x| [product_images(x).first && product_images(x).first["placeholder"] ? 1 : 0, -x["popularity"].to_i] }
  (chosen + auto).first(max)
end

# Petite vignette produit avec ajout direct (1 taille, 1 couleur) ou lien pour choisir
def look_item(x)
  img = product_images(x).first
  one = x["sizes"].size == 1 && x["colors"].size == 1
  action = one ? %(<button class="btn btn--ghost btn--sm" type="button" data-quick-add="#{x['slug']}">Ajouter</button>) : %(<a class="btn btn--ghost btn--sm" href="#{product_url(x)}">Choisir</a>)
  <<~HTML
    <div class="look-item">
      <a href="#{product_url(x)}" class="look-item__img">#{img ? img_tag(img, sizes: '72px', alt: '') : ''}</a>
      <div class="look-item__body"><a href="#{product_url(x)}">#{h(x['name'])}</a>#{price_html(x, 'card')}</div>
      #{action}
    </div>
  HTML
end

def reviews_for(p)
  REVIEWS[p["slug"]] || []
end

def rating_of(p)
  list = reviews_for(p)
  return nil if list.empty?
  (list.sum { |r| r["rating"] } / list.size.to_f).round(1)
end

def stars(value, cls: "stars")
  full = value.to_f.round
  %(<span class="#{cls}" aria-hidden="true">#{'★' * full}#{'☆' * (5 - full)}</span>)
end

def product_schema(p)
  imgs = product_images(p).reject { |i| i["placeholder"] }.map { |i| abs_url(i["src"]) }
  list = reviews_for(p)
  rating_data = list.empty? ? {} : {
    "aggregateRating" => { "@type" => "AggregateRating", "ratingValue" => rating_of(p), "reviewCount" => list.size, "bestRating" => 5, "worstRating" => 1 },
    "review" => list.first(10).map do |r|
      { "@type" => "Review", "author" => { "@type" => "Person", "name" => r["name"] }, "datePublished" => r["date"],
        "reviewBody" => r["text"], "reviewRating" => { "@type" => "Rating", "ratingValue" => r["rating"], "bestRating" => 5 } }
    end
  }
  {
    "@context" => "https://schema.org",
    "@type" => "Product",
    "name" => "#{p['name'].gsub(/[«»]/, '').squeeze(' ').strip} – Eden Park Arcachon",
    "sku" => p["reference"].to_s.empty? ? "EPA-#{p['slug'].upcase}" : p["reference"],
    "mpn" => p["reference"].to_s.empty? ? nil : p["reference"],
    "description" => p["description"].join(" "),
    "image" => imgs.empty? ? nil : imgs,
    "brand" => { "@type" => "Brand", "name" => "Eden Park" },
    "category" => cat_by_slug(p["category"])["name"],
    "color" => p["colors"].map { |c| c["name"] }.join(", "),
    "size" => p["sizes"].join(", "),
    "offers" => {
      "@type" => "Offer",
      "url" => abs_url(product_url(p)),
      "priceCurrency" => "EUR",
      "price" => euro_plain(effective_price(p)),
      "priceValidUntil" => (o = active_offer(p)) && !o["ends"].to_s.empty? ? o["ends"] : nil,
      "availability" => backorder_only?(p) ? "https://schema.org/BackOrder" : "https://schema.org/InStock",
      "itemCondition" => "https://schema.org/NewCondition",
      "seller" => { "@id" => abs_url("/#boutique") },
      "shippingDetails" => shipping_details,
      "hasMerchantReturnPolicy" => return_policy
    }.reject { |_, v| v.nil? }
  }.merge(rating_data).reject { |_, v| v.nil? }
end

# Vrai si toutes les variantes sont suivies et épuisées (vente « sur commande » uniquement)
def backorder_only?(p)
  s = STOCK[p["slug"]] || {}
  keys = p["colors"].product(p["sizes"]).map { |c, sz| "#{c['name']}|#{sz}" }
  keys.all? { |k| s[k].is_a?(Integer) && s[k] <= 0 }
end

def json_ld(obj)
  %(<script type="application/ld+json">#{JSON.generate(obj).gsub('</', '<\/')}</script>)
end

# ---------------------------------------------------------------------------
# Composants partagés
# ---------------------------------------------------------------------------

def swatches(p)
  dots = p["colors"].map do |c|
    accent = c["accent"] && c["accent"] != c["hex"] ? %(<i style="background:#{c['accent']}"></i>) : ""
    %(<span class="swatch-dot" style="background:#{c['hex']}" title="#{h(c['name'])}">#{accent}</span>)
  end.join
  %(<span class="swatches" aria-label="#{p['colors'].size} coloris">#{dots}</span>)
end

def product_card(p, heading: "h3")
  imgs = product_images(p)
  cat = cat_by_slug(p["category"])
  first = imgs[0]
  second = imgs[1]
  offer = active_offer(p)
  sale_badge = %(<span class="badge badge--sale" data-sale-badge="#{p['slug']}"#{offer ? '' : ' hidden'}>#{offer ? h(offer['ref'] ? sale_badge_text(offer) : offer['label']) : ''}</span>)
  badges = sale_badge + p["badges"].map.with_index { |b, i| %(<span class="badge#{i.zero? ? ' badge--pink' : ''}">#{h(b)}</span>) }.join
  sizes_attr = p["sizes"].join("|")
  colors_attr = p["colors"].map { |c| c["name"] }.join("|")
  one_size = p["sizes"].size == 1 && p["colors"].size == 1
  quick = if one_size
            %(<button class="btn btn--light btn--block card__quick" data-quick-add="#{p['slug']}">Ajouter au panier</button>)
          else
            %(<a class="btn btn--light btn--block card__quick" href="#{product_url(p)}" tabindex="-1">Choisir ma taille</a>)
          end
  <<~HTML
    <article class="card" data-slug="#{p['slug']}" data-cat="#{p['category']}" data-price="#{effective_price(p)}" data-sale="#{offer ? 1 : 0}" data-sizes="#{h(sizes_attr)}" data-colors="#{h(colors_attr)}" data-fit="#{h(p['fit'])}" data-date="#{p['date']}" data-pop="#{p['popularity']}">
      <div class="card__media">
        <div class="badges">#{badges}</div>
        #{img_tag(first)}
        #{second ? img_tag(second, cls: 'alt', alt: '') : ''}
        #{quick}
      </div>
      <div class="card__body">
        <span class="card__cat">#{h(cat['name'])}</span>
        <#{heading} class="card__name"><a href="#{product_url(p)}">#{h(p['name'])}</a></#{heading}>
        <div class="card__row">#{price_html(p, 'card')}#{swatches(p)}</div>
      </div>
    </article>
  HTML
end

def breadcrumb(items)
  lis = items.each_with_index.map do |(name, path), i|
    if i == items.size - 1
      %(<li aria-current="page">#{h(name)}</li>)
    else
      %(<li><a href="#{path}">#{h(name)}</a></li>)
    end
  end.join
  %(<nav class="breadcrumb wrap" aria-label="Fil d'Ariane"><ol>#{lis}</ol></nav>)
end

def hours_list(cls = "hours")
  items = SITE["hours"].map { |r| %(<li><span>#{h(r['days'])}</span><span>#{h(slots_label(r))}</span></li>) }.join
  %(<ul class="#{cls}">#{items}</ul>)
end

def address_html
  a = SITE["address"]
  %(#{h(a['street'])}<br>#{a['postal_code']} #{h(a['city'])})
end

def reassurance
  s = SITE["shipping"]
  items = [
    ["truck", "Livraison offerte dès #{euro(s['free_threshold'])}", "Colissimo France & DOM-TOM"],
    ["store", "Retrait gratuit en boutique", "296 bd de la Plage, Arcachon"],
    ["return", "Retours sous #{SITE['return_days']} jours", "Échange ou remboursement"],
    ["lock", "Paiement 100 % sécurisé", "Carte bancaire, Apple Pay, Google Pay"]
  ]
  inner = items.map { |ic, t, d| %(<div class="reassure__item">#{icon(ic)}<div><strong>#{h(t)}</strong><span>#{h(d)}</span></div></div>) }.join
  %(<section class="reassure" aria-label="Nos engagements"><div class="wrap reassure__grid">#{inner}</div></section>)
end

SIZE_GUIDE = [
  %w[XS 84-90 71-77], %w[S 91-97 78-84], %w[M 98-104 85-92], %w[L 105-111 93-99],
  %w[XL 112-118 100-106], %w[2XL 119-125 107-113], %w[3XL 126-132 114-120],
  %w[4XL 133-139 121-127], %w[5XL 140-146 128-134]
].freeze

def size_table
  rows = SIZE_GUIDE.map { |s, c, w| "<tr><td><strong>#{s}</strong></td><td>#{c}</td><td>#{w}</td></tr>" }.join
  <<~HTML
    <div class="table-wrap"><table>
      <caption class="sr-only">Guide des tailles Eden Park – hauts homme</caption>
      <thead><tr><th scope="col">Taille</th><th scope="col">Tour de poitrine (cm)</th><th scope="col">Tour de taille (cm)</th></tr></thead>
      <tbody>#{rows}</tbody>
    </table></div>
  HTML
end

def netlify_form_attrs(name, action = "/message-envoye/")
  %(name="#{name}" method="POST" action="#{action}" data-netlify="true" netlify-honeypot="bot-field")
end

def form_hidden(name)
  %(<input type="hidden" name="form-name" value="#{name}"><p class="hp"><label>Ne pas remplir : <input name="bot-field" tabindex="-1" autocomplete="off"></label></p>)
end

def rgpd_checkbox(id)
  %(<label class="consent" for="#{id}"><input type="checkbox" id="#{id}" name="consentement-rgpd" value="oui" required> <span>J'accepte que mes données soient utilisées par Eden Park Arcachon pour traiter ma demande, conformément à la <a href="/confidentialite/">politique de confidentialité</a>. Je peux exercer mes droits à tout moment.</span></label>)
end

# ---------------------------------------------------------------------------
# Rendu
# ---------------------------------------------------------------------------

class PageContext
  attr_accessor :path, :title, :description, :image, :schemas, :noindex, :body_class, :crumbs, :locals, :og_type

  def initialize(attrs = {})
    attrs.each { |k, v| send("#{k}=", v) }
    @schemas ||= []
    @locals ||= {}
    # expose les variables locales comme méthodes (prioritaires sur Kernel#p, etc.)
    @locals.each_key { |k| define_singleton_method(k) { @locals[k] } }
  end

  def get_binding
    binding
  end

  def method_missing(name, *args, &blk)
    return @locals[name.to_s] if @locals.key?(name.to_s)
    super
  end

  def respond_to_missing?(name, include_private = false)
    @locals.key?(name.to_s) || super
  end

  def render(file)
    tpl = File.read(File.join(SRC, file))
    ERB.new(tpl, trim_mode: "-").result(get_binding)
  end
end

PAGES = []

def write_page(ctx, template)
  ctx.crumbs ||= nil
  content = ctx.render(template)
  html = ctx.render("layout.erb").sub("<!--CONTENT-->") { content }
  out = ctx.path.end_with?(".html") ? File.join(DIST, ctx.path) : File.join(DIST, ctx.path, "index.html")
  FileUtils.mkdir_p(File.dirname(out))
  File.write(out, html)
  PAGES << ctx unless ctx.noindex
end

# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------

FileUtils.rm_rf(DIST)
FileUtils.mkdir_p(DIST)
FileUtils.cp_r(File.join(SRC, "assets"), File.join(DIST, "assets"))
FileUtils.cp_r(Dir[File.join(SRC, "static/*")], DIST) if Dir.exist?(File.join(SRC, "static"))
FileUtils.cp_r(File.join(SRC, "admin"), File.join(DIST, "admin"))

# Visuels provisoires
PRODUCTS.each do |p|
  product_images(p).each do |info|
    next unless info["placeholder"]
    path = File.join(DIST, "assets/img", info["file"])
    FileUtils.mkdir_p(File.dirname(path))
    File.write(path, info["svg"])
  end
end

# Catalogue exposé au JavaScript (panier, filtres)
js_catalog = {
  "shipping" => SITE["shipping"],
  "returnDays" => SITE["return_days"],
  "backorderDays" => SITE["shipping"]["backorder_days"],
  "gift" => SITE["gift"] || { "enabled" => false },
  "stock" => STOCK,
  "analyticsId" => analytics_on? ? SITE["analytics_id"] : "",
  "products" => PRODUCTS.map do |p|
    imgs = product_images(p)
    { "slug" => p["slug"], "name" => p["name"], "price" => p["price"], "url" => product_url(p), "offers" => PRICING[p["slug"]] || [],
      "look" => look_for(p).map { |x| x["slug"] }, "short" => p["short"], "cat" => p["category"],
      "search" => [p["name"], cat_by_slug(p["category"])["name"], p["short"], p["colors"].map { |c| c["name"] }.join(" "), (p["details"] || []).join(" "), (p["description"] || []).join(" ")].join(" "),
      "category" => cat_by_slug(p["category"])["name"],
      "colors" => p["colors"].map { |c| c["name"] }, "sizes" => p["sizes"],
      "images" => imgs.map { |i| { "src" => i["src720"] || i["src"], "variant" => i["variant"] } } }
  end
}
File.write(File.join(DIST, "assets/js/catalog.js"), "window.EP_CATALOG=#{JSON.generate(js_catalog)};\n")

# Médiathèque de l'admin : toutes les photos disponibles sur le site
library = Dir[File.join(SRC, "assets/img/**/*.jpg")].sort.reject { |f| f.end_with?("-720.jpg") || f.include?("/og-") }.map do |f|
  rel = f.sub(File.join(SRC, "assets/img/"), "")
  { "src" => rel, "thumb" => File.exist?(f.sub(/\.jpg\z/, "-720.jpg")) ? rel.sub(/\.jpg\z/, "-720.jpg") : rel }
end
File.write(File.join(DIST, "assets/img/library.json"), JSON.generate(library))

crumb_home = ["Accueil", "/"]
crumb_shop = ["Boutique", "/boutique/"]
featured = PRODUCTS.select { |p| p["featured"] }.sort_by { |p| -p["popularity"] }

# Accueil
write_page(PageContext.new(
  path: "/",
  title: "Eden Park Arcachon – Boutique en ligne Bassin d'Arcachon",
  description: "Polos et casquettes Eden Park brodés Bassin d'Arcachon, créés par la boutique d'Arcachon. Livraison offerte dès #{euro(SITE["shipping"]["free_threshold"])}, retrait en boutique.",
  image: "/assets/img/og-eden-park-arcachon.jpg",
  schemas: [store_schema, website_schema],
  locals: { "featured" => featured }
), "pages/index.erb")

# Boutique (tous les produits)
write_page(PageContext.new(
  path: "/boutique/",
  title: "Boutique en ligne – Collection Bassin | Eden Park Arcachon",
  description: "Polos et casquettes Eden Park brodés aux emblèmes du Bassin d'Arcachon. Paiement sécurisé, livraison France & DOM-TOM.",
  crumbs: [crumb_home, crumb_shop],
  schemas: [breadcrumb_schema([crumb_home, crumb_shop])],
  locals: { "category" => nil, "items" => PRODUCTS.sort_by { |p| -p["popularity"] } }
), "pages/shop.erb")

# Catégories (les catégories vides ne génèrent pas de page)
shop_cats.each do |c|
  items = PRODUCTS.select { |p| p["category"] == c["slug"] }.sort_by { |p| -p["popularity"] }
  crumbs = [crumb_home, crumb_shop, [c["name"], category_url(c)]]
  list = { "@context" => "https://schema.org", "@type" => "ItemList", "name" => c["title"],
           "itemListElement" => items.each_with_index.map { |p, i| { "@type" => "ListItem", "position" => i + 1, "url" => abs_url(product_url(p)), "name" => p["name"] } } }
  write_page(PageContext.new(
    path: category_url(c),
    title: "#{c['meta_title']}",
    description: c["meta_description"],
    image: c["image"] ? "/assets/img/#{c['image']}" : nil,
    crumbs: crumbs,
    schemas: [breadcrumb_schema(crumbs), list],
    locals: { "category" => c, "items" => items }
  ), "pages/shop.erb")
end

# Page des promotions en cours (générée seulement s'il y en a)
unless on_sale_products.empty?
  running = (SALES["campaigns"] || []).select { |c| c["active"] && BUILD_DATE >= c["starts"].to_s && BUILD_DATE <= c["ends"].to_s }
  soldes = running.any? { |c| c["kind"] == "soldes" }
  promo_cat = {
    "slug" => "promotions", "name" => soldes ? "Soldes" : "Promotions",
    "title" => soldes ? "Les soldes Eden Park Arcachon" : "Nos promotions du moment",
    "intro" => (running.map { |c| c["banner"] }.reject(&:empty?).first || "Profitez de nos prix réduits sur une sélection de pièces de la collection Bassin d'Arcachon, dans la limite des stocks disponibles.")
  }
  crumbs = [crumb_home, crumb_shop, [promo_cat["name"], "/boutique/promotions/"]]
  write_page(PageContext.new(
    path: "/boutique/promotions/",
    title: "#{promo_cat['title']} | Eden Park Arcachon",
    description: "#{promo_cat['intro']}"[0, 160],
    crumbs: crumbs,
    schemas: [breadcrumb_schema(crumbs)],
    locals: { "category" => promo_cat, "items" => on_sale_products.sort_by { |p| effective_price(p).to_f / p["price"] } }
  ), "pages/shop.erb")
end

# Fiches produits
PRODUCTS.each do |p|
  c = cat_by_slug(p["category"])
  crumbs = [crumb_home, crumb_shop, [c["name"], category_url(c)], [p["name"], product_url(p)]]
  related = PRODUCTS.reject { |x| x["slug"] == p["slug"] }.sort_by { |x| [x["category"] == p["category"] ? 0 : 1, -x["popularity"]] }.first(4)
  first_real = product_images(p).find { |i| !i["placeholder"] }
  plain_name = p["name"].gsub(/[«»]/, "").squeeze(" ").strip
  write_page(PageContext.new(
    path: product_url(p),
    title: "#{plain_name} | Eden Park Arcachon",
    description: "#{p['short']} #{euro(p['price'])}, exclusivité Eden Park Arcachon.",
    image: first_real ? first_real["src"] : nil,
    og_type: "product",
    crumbs: crumbs,
    schemas: [breadcrumb_schema(crumbs), product_schema(p)],
    locals: { "p" => p, "c" => c, "related" => related }
  ), "pages/product.erb")
end

# Pages éditoriales
simple_pages = [
  ["/notre-collection/", "pages/collection.erb", "Lookbook Bassin d'Arcachon | Eden Park Arcachon",
   "Découvrez la collection Eden Park Arcachon en images : polos Dune du Pyla, queue de baleine, silhouettes de saison et l'esprit French Flair sur le Bassin.", "Notre collection",
   "/assets/img/produits/polo-dune-du-pyla-marine-porte.jpg"],
  ["/personnalisation/", "pages/personnalisation.erb", "Broderie personnalisée | Eden Park Arcachon",
   "Broderies personnalisées Eden Park à Arcachon pour les entreprises, associations, clubs et événements du Bassin. Demandez votre projet sur mesure.", "Personnalisation",
   "/assets/img/produits/polo-dune-du-pyla-bassin-arcachon-broderie.jpg"],
  ["/boutique-arcachon/", "pages/boutique-arcachon.erb", "Boutique Eden Park Arcachon – 296 boulevard de la Plage",
   "Votre boutique Eden Park à Arcachon, 296 boulevard de la Plage, face au Bassin. Ouverte 7j/7 : horaires, accès, parking et accueil personnalisé.", "La boutique d'Arcachon",
   "/assets/img/boutique/boutique-eden-park-arcachon-interieur.jpg"],
  ["/contact/", "pages/contact.erb", "Contact – Eden Park Arcachon",
   "Contactez la boutique Eden Park d'Arcachon : téléphone, e-mail, formulaire et adresse au 296 boulevard de la Plage. Réponse sous 48 h.", "Contact", nil],
  ["/livraison-retours/", "pages/livraison.erb", "Livraison et retours | Eden Park Arcachon",
   "Livraison Colissimo en France et DOM-TOM, offerte dès #{euro(SITE["shipping"]["free_threshold"])}. Retrait gratuit en boutique à Arcachon. Retours et échanges sous #{SITE["return_days"]} jours.", "Livraison et retours", nil],
  ["/faq/", "pages/faq.erb", "FAQ & guide des tailles | Eden Park Arcachon",
   "Questions fréquentes sur la boutique en ligne Eden Park Arcachon : commande, livraison, retours, paiement, guide des tailles et entretien.", "FAQ", nil],
  ["/cgv/", "pages/cgv.erb", "Conditions générales de vente | Eden Park Arcachon",
   "Conditions générales de vente de la boutique en ligne Eden Park Arcachon (MAMIL27 SAS) : commande, prix, paiement, livraison, rétractation, garanties.", "CGV", nil],
  ["/mentions-legales/", "pages/mentions.erb", "Mentions légales | Eden Park Arcachon",
   "Mentions légales du site edenpark-arcachon.fr : éditeur, hébergeur, propriété intellectuelle.", "Mentions légales", nil],
  ["/confidentialite/", "pages/confidentialite.erb", "Politique de confidentialité | Eden Park Arcachon",
   "Politique de confidentialité et protection des données personnelles (RGPD) de la boutique en ligne Eden Park Arcachon.", "Confidentialité", nil],
  ["/cookies/", "pages/cookies.erb", "Politique de cookies | Eden Park Arcachon",
   "Utilisation des cookies sur edenpark-arcachon.fr et gestion de vos préférences.", "Cookies", nil]
]
simple_pages.each do |path, tpl, title, desc, crumb, image|
  crumbs = [crumb_home, [crumb, path]]
  schemas = [breadcrumb_schema(crumbs)]
  schemas << store_schema if %w[/boutique-arcachon/ /contact/].include?(path)
  ctx = PageContext.new(path: path, title: title, description: desc, image: image, crumbs: crumbs, schemas: schemas)
  if path == "/faq/"
    ctx.locals["faq_schema_holder"] = []
  end
  write_page(ctx, tpl)
end

# Journal (articles saisis dans l'admin)
journal_crumbs = [crumb_home, ["Le Journal", "/journal/"]]
write_page(PageContext.new(
  path: "/journal/",
  title: "Le Journal – Conseils, coulisses et Bassin d'Arcachon | Eden Park Arcachon",
  description: tokens((CONTENT["journal_intro"] || {})["lead"]).to_s[0, 160],
  crumbs: journal_crumbs,
  schemas: [breadcrumb_schema(journal_crumbs)]
), "pages/journal.erb")
journal_articles.each do |a|
  crumbs = journal_crumbs + [[a["title"], article_url(a)]]
  img = a["image"] && !a["image"]["src"].to_s.empty? ? "/assets/img/#{a['image']['src']}" : nil
  article_schema = {
    "@context" => "https://schema.org", "@type" => "BlogPosting", "headline" => a["title"], "description" => tokens(a["excerpt"]),
    "datePublished" => a["date"], "dateModified" => a["date"], "inLanguage" => "fr-FR", "mainEntityOfPage" => abs_url(article_url(a)),
    "image" => img ? abs_url(img) : nil,
    "author" => { "@type" => "Organization", "name" => SITE["name"], "url" => abs_url("/") },
    "publisher" => { "@type" => "Organization", "name" => SITE["name"], "logo" => { "@type" => "ImageObject", "url" => abs_url("/assets/img/logo-eden-park-arcachon.png") } }
  }.reject { |_, v| v.nil? }
  write_page(PageContext.new(
    path: article_url(a),
    title: "#{a['title']} | Eden Park Arcachon",
    description: tokens(a["excerpt"]).to_s[0, 160],
    image: img,
    og_type: "article",
    crumbs: crumbs,
    schemas: [breadcrumb_schema(crumbs), article_schema],
    locals: { "a" => a }
  ), "pages/article.erb")
end

# Pages techniques (non indexées)
write_page(PageContext.new(path: "/recherche/", title: "Rechercher | Eden Park Arcachon", description: "Rechercher un produit Eden Park Arcachon.", noindex: true), "pages/recherche.erb")
write_page(PageContext.new(path: "/panier/", title: "Mon panier | Eden Park Arcachon", description: "Votre panier Eden Park Arcachon.", noindex: true), "pages/panier.erb")
write_page(PageContext.new(path: "/merci/", title: "Merci pour votre commande | Eden Park Arcachon", description: "Confirmation de commande.", noindex: true), "pages/merci.erb")
write_page(PageContext.new(path: "/message-envoye/", title: "Message envoyé | Eden Park Arcachon", description: "Votre message a bien été envoyé.", noindex: true), "pages/message-envoye.erb")
write_page(PageContext.new(path: "/404.html", title: "Page introuvable | Eden Park Arcachon", description: "Cette page n'existe pas ou plus.", noindex: true, locals: { "featured" => featured.first(4) }), "pages/404.erb")

# sitemap.xml
urls = PAGES.map do |pg|
  prio = pg.path == "/" ? "1.0" : (pg.path.start_with?("/produit/") || pg.path.start_with?("/boutique/") ? "0.8" : "0.5")
  prio = "0.3" if %w[/cgv/ /mentions-legales/ /confidentialite/ /cookies/].include?(pg.path)
  img = pg.image ? "\n    <image:image><image:loc>#{abs_url(pg.image)}</image:loc></image:image>" : ""
  "  <url>\n    <loc>#{abs_url(pg.path)}</loc>\n    <lastmod>#{TODAY}</lastmod>\n    <priority>#{prio}</priority>#{img}\n  </url>"
end
File.write(File.join(DIST, "sitemap.xml"), <<~XML)
  <?xml version="1.0" encoding="UTF-8"?>
  <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  #{urls.join("\n")}
  </urlset>
XML

# Flux produits Google Merchant Center (fiches gratuites Google Shopping)
GOOGLE_CATEGORIES = {
  "casquettes-accessoires" => "Apparel & Accessories > Clothing Accessories > Hats"
}.freeze
def xml(s)
  CGI.escapeHTML(s.to_s)
end
feed_items = PRODUCTS.flat_map do |p|
  photos = product_images(p).reject { |i| i["placeholder"] }
  next [] if photos.empty? # Google exige une vraie photo
  stock = STOCK[p["slug"]] || {}
  p["colors"].product(p["sizes"]).map do |c, sz|
    q = stock["#{c['name']}|#{sz}"]
    late = q.is_a?(Integer) && q <= 0
    variant_photos = photos.select { |i| i["variant"].nil? || i["variant"] == c["name"] }
    variant_photos = photos if variant_photos.empty?
    plain = p["name"].gsub(/[«»]/, "").squeeze(" ").strip
    s = SITE["shipping"]
    <<~ITEM
      <item>
        <g:id>#{xml(slugify("#{p['slug']}-#{c['name']}-#{sz}"))}</g:id>
        <g:item_group_id>#{xml(p['slug'])}</g:item_group_id>#{p['reference'].to_s.empty? ? '' : "\n        <g:mpn>#{xml(p['reference'])}</g:mpn>"}
        <g:title>#{xml("#{plain} Eden Park – #{c['name']}#{sz == 'Taille unique' ? '' : " – taille #{sz}"}")}</g:title>
        <g:description>#{xml(p['description'].join(' '))}</g:description>
        <g:link>#{xml(abs_url(product_url(p)))}</g:link>
        <g:image_link>#{xml(abs_url(variant_photos.first['src']))}</g:image_link>
    #{variant_photos.drop(1).first(9).map { |i| "    <g:additional_image_link>#{xml(abs_url(i['src']))}</g:additional_image_link>" }.join("\n")}
        <g:price>#{euro_plain(p['price'])} EUR</g:price>
    #{(so = active_offer(p)) ? "    <g:sale_price>#{euro_plain(so['price'])} EUR</g:sale_price>" + (so['ends'].to_s.empty? ? '' : "\n        <g:sale_price_effective_date>#{so['starts'].to_s.empty? ? BUILD_DATE : so['starts']}T00:00+01:00/#{so['ends']}T23:59+01:00</g:sale_price_effective_date>") : ''}
        <g:availability>#{late ? 'backorder' : 'in_stock'}</g:availability>
    #{late ? "    <g:availability_date>#{(Date.today + (s['backorder_days'] || 15)).iso8601}T12:00+02:00</g:availability_date>" : ''}
        <g:brand>Eden Park</g:brand>
        <g:condition>new</g:condition>
        <g:identifier_exists>no</g:identifier_exists>
        <g:google_product_category>#{xml(GOOGLE_CATEGORIES[p['category']] || 'Apparel & Accessories > Clothing > Shirts & Tops')}</g:google_product_category>
        <g:product_type>#{xml("Collection Bassin d'Arcachon > #{cat_by_slug(p['category'])['name']}")}</g:product_type>
        <g:color>#{xml(c['name'])}</g:color>
        <g:size>#{xml(sz == 'Taille unique' ? 'TU' : sz)}</g:size>
        <g:gender>male</g:gender>
        <g:age_group>adult</g:age_group>
        <g:shipping><g:country>FR</g:country><g:service>Colissimo</g:service><g:price>#{euro_plain(p['price'] >= s['free_threshold'] ? 0 : s['metro_price'])} EUR</g:price></g:shipping>
      </item>
    ITEM
  end
end
File.write(File.join(DIST, "google-merchant.xml"), <<~XML)
  <?xml version="1.0" encoding="UTF-8"?>
  <rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>Eden Park Arcachon</title>
    <link>#{abs_url('/')}</link>
    <description>Collection exclusive Bassin d'Arcachon – boutique Eden Park d'Arcachon</description>
  #{feed_items.join}
  </channel>
  </rss>
XML

File.write(File.join(DIST, "robots.txt"), <<~TXT)
  User-agent: *
  Allow: /
  Disallow: /panier/
  Disallow: /merci/
  Disallow: /message-envoye/
  Disallow: /admin/
  Disallow: /api/

  Sitemap: #{abs_url('/sitemap.xml')}
TXT

# Récapitulatif des éléments provisoires
puts "Site généré dans dist/ (#{PAGES.size} pages indexables, version #{ASSET_VERSION})."
puts
puts "Éléments à compléter :"
PRODUCTS.each { |p| puts "  - #{p['name']} : #{p['provisional'].join(', ')}" if p["provisional"] && !p["provisional"].empty? }
puts "  - E-mail de contact (#{SITE['email']})" if SITE["email_provisional"]
puts "  - Médiateur de la consommation (data/site.json > legal)" if SITE["legal"]["mediator"].to_s.strip.empty?
