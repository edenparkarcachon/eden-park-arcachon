# Eden Park Arcachon — boutique en ligne

Site e-commerce sur-mesure de la boutique Eden Park d'Arcachon (296 bd de la Plage) : collection exclusive Bassin d'Arcachon, panier, paiement Stripe, livraison Colissimo France & DOM-TOM, retrait gratuit en boutique.

- **Site statique** généré par un script Ruby (`build.rb`), donc rapide, sûr (pas de WordPress à mettre à jour) et très bien référencé.
- **Paiement** : Stripe Checkout via une petite fonction serveur Netlify (`netlify/functions/checkout.mjs`). Les prix sont recalculés côté serveur à partir du catalogue.
- **Espace administration** (`/admin/`) : ajout et modification des produits, photos, stock par couleur et taille, suivi des commandes. Données stockées dans Netlify Blobs.
- **Stock** : décompté automatiquement à chaque paiement (webhook Stripe). À 0, l’article reste en vente avec un délai de **15 jours**.
- **Formulaires** (contact, personnalisation, newsletter) : Netlify Forms, avec case de consentement RGPD.
- **Hébergement conseillé** : Netlify (offre gratuite suffisante pour démarrer).

## Arborescence

```
data/site.json          Infos boutique : adresse, horaires, téléphone, mentions légales, livraison
data/products.json      Catalogue et catégories de départ
data/content.json       Textes et photos des pages (valeurs de départ)
src/layout.erb          Gabarit commun (en-tête, pied de page, cookies, mini-panier)
src/pages/*.erb         Contenu de chaque page
src/admin/              Espace d'administration (/admin/)
src/assets/             CSS, JS, polices, images
netlify/functions/      Fonctions serveur : paiement, stock, webhook Stripe, admin
netlify/lib/            Code partagé : stockage, catalogue, authentification
scripts/                Synchronisation du catalogue, serveur local, tests
build.rb                Générateur → écrit le site dans dist/
```

## Espace administration (pour la boutique)

Adresse : **https://edenpark-arcachon.fr/admin/**. Le mot de passe est défini dans la variable Netlify `ADMIN_PASSWORD`.

- **Produits** : créer, modifier, supprimer.
  - Pour chaque produit : nom, catégorie, prix, textes, couleurs, tailles, photos et stock.
  - Les photos prises au téléphone sont redimensionnées automatiquement.
  - La première photo est la photo principale. On peut associer une photo à une couleur : la fiche produit l'affiche quand le client choisit cette couleur.
  - L'adresse de la page (ex. `/produit/polo-dune-du-pyla/`) est fixée à la création, pour ne pas perdre le référencement Google.
  - Après **Enregistrer**, la modification est mise en attente ; le bouton **Publier les modifications** (en haut de l’admin) met tout en ligne en 1 à 2 minutes.
- **Stock** : tableau de tous les produits, par couleur et par taille.
  - Une modification est visible **immédiatement** sur le site, sans reconstruction.
  - Case vide = stock non suivi : l'article est considéré disponible.
  - Chaque commande payée **décompte automatiquement** le stock.
  - À **0**, ou si le client en commande plus que le stock, l'article **reste en vente**. Le délai passe à **15 jours** et s'affiche sur la fiche produit, dans le panier, sur la page de paiement Stripe et dans l'e-mail de confirmation. Le délai se règle dans `data/site.json` (`shipping.backorder_days`).
- **Commandes** : liste des commandes payées (client, adresse, articles, total), avec les articles « sur commande » signalés. Remboursements et détails complets : tableau de bord Stripe.

- **Pages & photos** : tous les textes et toutes les photos des pages.
  - **Accueil** : grande bannière et ses boutons, notre histoire, emblèmes, personnalisation, boutique, photos Instagram.
  - **Notre collection** : lookbook, histoire, essentiels de la saison.
  - **La boutique d'Arcachon** : photos, accès, services.
  - **Bandeau d'annonce et pied de page**.
  - On peut ajouter, retirer ou réordonner les photos et les blocs.
- **Catégories** : ajouter, renommer, réordonner, changer la photo et les textes (introduction, titre et description pour Google).
  - Une catégorie vide n'apparaît pas dans le menu tant qu'elle n'a pas de produit.
  - Une catégorie qui contient des produits ne peut pas être supprimée.
- **Réglages** :
  - téléphone, e-mail, adresse, position sur la carte ;
  - horaires (plusieurs lignes, jours cochés) ;
  - Instagram et Facebook ;
  - tarifs et délais Colissimo, seuil de livraison offerte, délai « sur commande », délai de retour ;
  - capital social, médiateur, directeur de publication ;
  - description générale et identifiant Google Analytics.

  Tout est vérifié à l'enregistrement : horaires bien écrits, retour d'au moins 14 jours, liens valides… Les informations officielles (SIRET, TVA, RCS) ne sont pas modifiables.
- **Médiathèque** : chaque bouton « Changer la photo » ouvre la liste de toutes les photos du site. On peut en choisir une ou en envoyer une nouvelle. Elle est aussi accessible depuis la fiche produit (« Choisir dans la médiathèque »).

- **Publication groupée** : un enregistrement ne met plus le site en ligne immédiatement. La barre en haut de l'admin indique les modifications en attente (« 3 modifications à publier ») ; le bouton **Publier les modifications** les met toutes en ligne en une fois, en 1 à 2 minutes.
  - Pourquoi : sur le plan gratuit Netlify (300 crédits/mois), chaque mise en ligne coûte 15 crédits, soit environ 20 par mois ; une fois le plafond atteint, le site est suspendu jusqu'au mois suivant. Le suivi se fait dans *Netlify → Usage & billing*.
  - Sont actifs **immédiatement, sans publication** : le stock, les codes promo, le suivi des commandes.
- **Commandes** : chaque commande payée arrive avec le statut « À préparer ». On la passe en « Prête en boutique », « Expédiée » (avec le numéro de suivi Colissimo), « Livrée / retirée » ou « Annulée ». Le bouton **Prévenir le client** ouvre votre messagerie avec un e-mail déjà rédigé (lien de suivi La Poste inclus). Le nombre de commandes à préparer s'affiche sur l'onglet.
- **Codes promo** : pourcentage, montant fixe ou livraison offerte ; montant minimum, dates de validité, nombre d'utilisations maximum, catégories concernées. Le client saisit le code dans son panier ; la remise est recalculée par le serveur et transmise à Stripe. Chaque utilisation est comptée au paiement.
- **Soldes & promos** : campagnes de réduction en pourcentage (tout le catalogue, certaines catégories ou certains produits), avec dates de début et de fin, étiquette (« Soldes », « Black Friday »…) et message facultatif dans le bandeau du haut. On peut aussi fixer un **prix promotionnel** sur un seul produit (fiche produit → « Prix promotionnel »).
  - Le client bénéficie toujours de la meilleure réduction, sans cumul. Les codes promo peuvent exclure les articles déjà réduits.
  - **Prix barré légal** : il est calculé automatiquement comme le prix le plus bas pratiqué pendant les 30 jours précédant la réduction (article L112-1-1 du Code de la consommation), grâce à l'historique des prix enregistré par l'admin. S'il n'y a pas de vraie baisse, aucun prix barré n'est affiché.
  - **Mot « Soldes »** : réservé aux périodes officielles (hiver : à partir du 2e mercredi de janvier ; été : à partir du dernier mercredi de juin ; 4 semaines). L'admin affiche les prochaines dates et prévient si une campagne « Soldes » en sort. En dehors, utiliser le type « Promotion ».
  - **Début et fin automatiques** : le panier et le paiement appliquent le bon prix à la bonne date. Une tâche planifiée Netlify (`sales-scheduler`) republie le site la nuit où une campagne commence ou se termine ; le navigateur recalcule aussi les prix affichés à la date du jour.
  - Pendant une campagne, une page `/boutique/promotions/` et un filtre « En promotion » apparaissent automatiquement ; le flux Google Shopping indique le prix soldé.
- **Complétez le look** : dans la fiche produit, cochez les produits à proposer avec celui-ci (fiche produit et panier, avec ajout direct pour les articles à taille unique). Sans sélection, le site propose automatiquement des produits d'autres catégories.
- **Emballage cadeau** (Réglages → Emballage cadeau) : option du panier, offerte ou payante, avec un message de 200 caractères maximum. Il apparaît sur la commande dans l'onglet Commandes (« 🎁 Emballage cadeau » et message à glisser dans le paquet).
- **Avis** : les avis déposés sur les fiches produits attendent votre validation (**Publier** / **Masquer** / **Supprimer**). « Achat vérifié » s'affiche si l'e-mail saisi a commandé ce produit. Les étoiles apparaissent sur la fiche et dans Google après « Publier ».
- **FAQ** (Pages & photos → FAQ) : rubriques et questions modifiables.
- **Journal** (Pages & photos → Journal) : articles avec photo, résumé et texte mis en forme (intertitres « ## », listes « - », **gras**, liens `[texte](/page/)`). Un article décoché « Publié » reste en brouillon.
- **Mots magiques** : dans la FAQ, le bandeau du haut et les articles, `{livraison_offerte}`, `{prix_livraison}`, `{prix_domtom}`, `{delai_france}`, `{delai_domtom}`, `{delai_retour}`, `{delai_sur_commande}`, `{telephone}` et `{email}` sont remplacés par les valeurs des Réglages : les textes restent justes quand un tarif change.

Tout ce qui est modifié dans l'admin est stocké dans Netlify Blobs, puis réinjecté dans `data/*.json` à chaque construction par le plugin de build `netlify/plugins/sync-catalog` (qui appelle `scripts/sync-catalog.mjs`). Les fichiers du dépôt ne servent que de valeurs de départ.

## Mise en ligne (étapes)

1. **Nom de domaine** : acheter `edenpark-arcachon.fr` (OVH, Gandi, ou directement dans Netlify).
2. **GitHub + Netlify** :
   - déposer ce dossier dans un dépôt GitHub privé ;
   - dans Netlify : *Add new site → Import from Git*. Les réglages de build sont lus dans `netlify.toml` ;
   - ajouter le domaine dans *Domain management*. Le HTTPS est automatique et gratuit.
   - ⚠️ Le glisser-déposer simple ne suffit pas : il n'active ni les fonctions serveur (paiement, admin, stock) ni la reconstruction automatique.
3. **Variables d'environnement** (Netlify → *Site configuration → Environment variables*) :

   | Variable | Valeur |
   |---|---|
   | `ADMIN_PASSWORD` | mot de passe de l'espace admin (long et unique) |
   | `SITE_URL` | `https://edenpark-arcachon.fr` |
   | `STRIPE_SECRET_KEY` | clé secrète Stripe (`sk_test_…` pour tester, puis `sk_live_…`) |
   | `STRIPE_WEBHOOK_SECRET` | secret du webhook Stripe (`whsec_…`, voir étape 5) |
   | `BUILD_HOOK_URL` | URL du hook de build (voir étape 4) |

4. **Reconstruction automatique** : Netlify → *Site configuration → Build & deploy → Build hooks → Add build hook* (nom « Admin »). Copier l'URL dans `BUILD_HOOK_URL`.
5. **Stripe** :
   - créer le compte sur stripe.com ;
   - *Développeurs → Webhooks → Ajouter un endpoint* : URL `https://edenpark-arcachon.fr/api/stripe-webhook`, événements `checkout.session.completed` et `checkout.session.async_payment_succeeded`. Copier le secret de signature dans `STRIPE_WEBHOOK_SECRET` ;
   - tester avec la carte `4242 4242 4242 4242` (date future et CVC quelconques), puis vérifier que le stock a baissé dans l'admin ;
   - activer les **reçus par e-mail** (*Settings → Customer emails*) ;
   - pour vendre pour de vrai : activer le compte (SIRET, IBAN), puis remplacer les clés et le webhook par ceux du mode *live*.
6. **Formulaires** : dans Netlify → *Forms*, activer la détection des formulaires et ajouter une notification e-mail vers l'adresse de la boutique. Les messages et les inscrits à la newsletter y sont consultables et supprimables, ce qui sert aussi de registre RGPD.
7. **Google** :
   - créer une propriété **Google Analytics 4** et copier l'identifiant `G-…` dans `data/site.json` (`analytics_id`). Il n'est chargé qu'après acceptation des cookies ;
   - ajouter le site dans **Google Search Console** et soumettre `https://edenpark-arcachon.fr/sitemap.xml` ;
   - dans la fiche **Google Business Profile** de la boutique, renseigner l'adresse du site.

## Côté visiteurs

- **Recherche** : loupe dans l'en-tête (ou touche « / »), résultats instantanés par nom, couleur, broderie ou description, et page complète `/recherche/?q=…`.
- **Zoom plein écran** sur les photos produit : clic sur la photo, flèches ou balayage pour passer d'une photo à l'autre, Échap pour fermer.

## Notifications e-mail

- **Messages du site** (contact, personnalisation, newsletter) : Netlify → *Project configuration → Notifications → Emails and webhooks → Form submission notifications → Add notification → Email notification*. Choisir « Any form » et saisir l'adresse de la boutique.
- **Commandes** : dans Stripe → *Paramètres → Notifications* (ou *Settings → Personal details → Communication preferences*), cocher « Paiements réussis » pour recevoir un e-mail à chaque vente. Le détail (tailles, adresse, « sur commande ») est dans l'onglet **Commandes** de l'admin.

## Google Shopping (fiches produits gratuites)

Le site génère automatiquement un flux produits à l'adresse `/google-merchant.xml` (une ligne par couleur et par taille, prix, disponibilité, photos). Les produits sans vraie photo en sont exclus, car Google exige une photo.

1. Créer un compte sur **merchants.google.com** avec le compte Google de la boutique, puis valider le site (avec le domaine définitif).
2. *Produits → Ajouter des produits → Fichier* : choisir « Récupération planifiée » et indiquer `https://edenpark-arcachon.fr/google-merchant.xml`, récupération quotidienne.
3. Configurer la livraison (Colissimo, tarifs et seuil de livraison offerte) et la politique de retour (30 jours) dans Merchant Center.
4. Activer les « fiches gratuites » (onglet Croissance) : les produits apparaissent dans Google Shopping sans frais.

## Développement local

Il faut Node.js (nodejs.org) et Ruby (préinstallé sur Mac).

```bash
npm install
```

```bash
node scripts/dev-server.mjs
```

Ouvrir http://localhost:8888. L'admin est sur http://localhost:8888/admin/ ; le mot de passe local par défaut est défini dans `scripts/dev-server.mjs`. En local, les données sont stockées dans `.local-store/`. Sans clé Stripe, le paiement est simulé : la commande est enregistrée et le stock décompté comme en réel.

**Préparer la boutique avant la mise en ligne** : tout ce qui est enregistré dans l'admin local est recopié dans les fichiers du projet à chaque enregistrement :
- produits, catégories, textes et réglages → `data/*.json` ;
- stock → `data/stock.json` ;
- photos → `src/assets/img/uploads/`.

Ces fichiers servent de point de départ au premier déploiement sur Netlify : rien n'est à ressaisir. Les commandes de test passées en local ne sont pas transférées.

Tests automatiques des fonctions serveur (connexion, stock, décompte, délai de 15 jours, webhook, photos) :

```bash
npm test
```

## À compléter avant la mise en ligne

| Élément | Où |
|---|---|
| Prix, tailles et compositions exactes des produits | `data/products.json` |
| T-shirts et sweat : confirmer les modèles et fournir les photos | `data/products.json` + `src/assets/img/produits/` |
| E-mail de contact (provisoire : contact@edenpark-arcachon.fr) | `data/site.json` → `email` |
| Capital social de MAMIL27 | `data/site.json` → `legal.capital` |
| Médiateur de la consommation (obligatoire) | `data/site.json` → `legal.mediator` |
| Identifiant Google Analytics | `data/site.json` → `analytics_id` |
| Relecture des CGV / mentions légales par un professionnel du droit | `src/pages/cgv.erb`, `mentions.erb`, `confidentialite.erb` |
| Logo officiel Eden Park en vectoriel (le logo actuel est une recréation) | `build.rb` → fonction `logo` ; `src/assets/img/logo-eden-park-arcachon.png` |

## Référencement (SEO) déjà en place

- Titres et descriptions uniques par page, URL lisibles en français, balise canonique.
- Données structurées schema.org :
  - `ClothingStore` : adresse, coordonnées GPS, horaires, réseaux sociaux ;
  - `Product` : prix, disponibilité, livraison, retours 30 jours ;
  - `BreadcrumbList`, `ItemList`, `FAQPage` et `WebSite`.
- `sitemap.xml` avec les images, `robots.txt`, page 404 personnalisée.
- Balises Open Graph pour le partage sur Facebook et WhatsApp, image de partage dédiée.
- Référencement local :
  - contenus autour d'Arcachon, du Bassin, du Pyla, de la jetée Thiers ;
  - page dédiée à la boutique avec carte ;
  - balises géographiques.
- Performance :
  - polices hébergées sur le site (aucun appel à Google Fonts) ;
  - images optimisées en plusieurs tailles et chargement différé ;
  - CSS et JS légers, sans aucune bibliothèque ;
  - cache long durée sur les fichiers statiques.
- Accessibilité :
  - textes alternatifs sur les images ;
  - navigation au clavier et lien d'évitement ;
  - contrastes adaptés.
