/**
 * KV Code Import Script
 * Reads KV product codes from two Excel files, matches them to products,
 * and patches default-db.json with kvCode fields.
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// === FILE PATHS ===
const DB_PATH = path.join(__dirname, 'default-db.json');
const FILE1_PATH = path.join(__dirname, 'Bảng giá', 'Mã hàng hóa KV.xlsx');
const FILE2_PATH = path.join(__dirname, 'Bảng giá', 'Tổng hợp Bảng giá và Quà tặng Zentor Workshop 2026 V5.xlsx');

// === BRAND MAPPING ===
const CAMPAIGN_BRAND = {
  'xvil': 'xvil',
  'zentor': 'zentor',
  'zentor': 'zentor',
  'zentor': 'zentor',
  'torvex': 'torvex',
  'veltron': 'veltron',
  'tvx': 'torvex'  // TVX products use Torvex brand name
};

// Manual override mappings: KV code -> db.js product id
const MANUAL_OVERRIDES = {
  'FG018F4': 'tvx_furvex_20w50_cf4_18',        // Torvex Furvex 20W50 CF4 18L
  'FL018I4': 'tvx_furvex_20w50_ci4_18',        // Torvex Furvex 20W50 CI4 18L
  'FG018I4': 'tvx_furvex_15w40_ci4_18',        // Torvex Furvex 15W40 CI4 18L
  '8230001': 'znt_mxo_topgear_gp_chain_cleaner',  // Chain Cleaner
  '8230002': 'znt_mxo_topgear_gp_windshield_cleaner', // Windshield Cleaner
  '1170001-001': 'veltron_veltron_racing_4t_motobike_10w40', // Veltron Racing 4T
  '8230003': 'znt_mxo_zentor_topgear_gp_brake_fluid_320_ester', // Override: Brake Fluid 320
  '8230009': 'znt_mxo_pro_pulse_tt_coolant', // Override: Prostream TT Coolant
  '8230010': 'znt_mxo_zentor_topgear_gp_fork_oil_2_5w', // Override: Fork Oil 2.5W
  '8230011': 'znt_mxo_zentor_topgear_gp_fork_oil_7_5w', // Override: Fork Oil 7.5W
  '8230004': 'znt_mxo_topgear_gp_chain_lube_off_road', // Override: Chain Lube Off Road
  '8230005': 'znt_mxo_topgear_gp_chain_lube_max', // Override: Chain Lube Max
  '8230006': 'znt_mxo_zentor_topgear_gp_2t_ester', // Topgear GP 2T Ester+
  '8230007': 'znt_pcmo_zentor_oem_specific_atf_9g',   // Override: ATF 9G
  '8230008': 'znt_mxo_topgear_gp_chain_lube_trang', // Override: Chain Lube (trắng/regular)
};

// === HELPERS ===
function normalizeStr(s) {
  if (!s) return '';
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function normalizeCode(code) {
  if (!code) return '';
  return String(code).trim().replace(/-1$/, '');
}

function extractViscosity(text) {
  const t = text.toUpperCase();
  const patterns = [
    /(\d+W[- ]?\d+)/,  // 5W30, 10W-40, 5W 40
    /(\d+W\b)/,        // standalone 5W
    /(DOT\s*[\d.]+)/,   // DOT 5.1
    /(GL[\s-]*\d)/,     // GL5, GL-5
  ];
  const results = [];
  for (const p of patterns) {
    const m = t.match(p);
    if (m) results.push(m[1].replace(/[\s-]/g, '').toUpperCase());
  }
  return results;
}

function extractVolume(text) {
  const t = text.toUpperCase();
  const patterns = [
    /(\d+(?:[.,]\d+)?)\s*(?:L|LIT)\b/,    // 1L, 4L, 0.5L
    /(\d+)\s*ML\b/,                         // 500ML, 400ML
    /(\d+)\s*GR?\b/,                        // 400G
    /(\d+)\s*KG\b/,                         // 18KG
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m) {
      if (p === patterns[1]) return parseInt(m[1]) + 'ML';
      if (p === patterns[2]) return parseInt(m[1]) + 'G';
      if (p === patterns[3]) return parseInt(m[1]) + 'KG';
      const vol = parseFloat(m[1].replace(',', '.'));
      if (vol < 1) return Math.round(vol * 1000) + 'ML';
      return vol + 'L';
    }
  }
  return null;
}

function extractProductLine(text) {
  const t = text.toUpperCase();
  const lines = [
    'TOPGEAR GP', 'PROSTREAM TT', 'ACTIVE DEFENCE', 'ECO FLOW',
    'OEM SPECIFIC', 'OEM LEVEL', 'FAST 4T', 'FAST SCOOT', 'FURIOUS',
    'FURVEX', 'Max FORCE', 'KAITEN', 'R8000', 'STROKE 4',
    'BOX 2', 'BOX X', 'Moto XP', 'LIFE EXTENSION', 'BRAKE FLUID',
    'COOLANT', 'CHAIN LUBE', 'CHAIN CLEANER', 'FORK OIL', 'ENGINE FLUSH',
    'GASOLINE TREATMENT', 'DIESEL TREATMENT', 'SILICONE SPRAY',
    'WASH AND SHINE', 'PLASTIC SHINE', 'HAND CLEANER', 'WHEEL CLEANER',
    'RADIATOR CLEANER', 'CENTRAL HYDRAULIC', 'DSG FLUID', 'CVT FLUID',
    'ATF', 'GEAR OIL', 'TRANSMISSION OIL', 'SELF OIL', 'SCOOT RUN',
    'CLUTCH ONE', 'CLEANER POLISH', 'MOTO WASH', 'AIR FILTER',
    'XTORQ CHAIN', 'XTORQ BRAKE', 'CHAIN CARE KIT', 'WINDSHIELD CLEANER',
    'LITHIUM COMPLEX', 'DISPLAY', 'CANVAS', 'KEYRING', 'BEACHFLAG',
    'STICKER', 'CAP', 'POLO', 'RAINCOAT', 'STRING BAG',
    'SCOOTER GEAR OIL', 'DOT 5.1', 'DOT 4',
    'RSP RACING', 'VMP', 'HLS', 'FDS', 'FO SAE', 'RUP RACING',
    'RRS SAE', 'ECO SYNTH', 'LOW EMISSION', 'TURBO PLUS',
    'FORMEL EXTRA', 'FORMEL DIESEL', 'PETROL OCTANE',
    'ALU FELGEN', 'AUTO POLITUR', 'ENGINE CLEANER',
    'SCOOTER 4 TAKT', 'MULTI VEHICLE', 'NEW ENERGY',
    'CVT FLUID', '8HP FLUID', 'M 9 SERIE',
  ];
  for (const l of lines) {
    if (t.includes(l)) return l;
  }
  return null;
}

// === STEP 1: Read Excel files ===
function readFile1() {
  const wb = XLSX.readFile(FILE1_PATH);
  const ws = wb.Sheets[Object.keys(wb.Sheets)[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  
  const codes = new Map(); // code -> {code, name, brand}
  
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[1]) continue;
    
    const rawCode = String(row[1]).trim();
    if (!rawCode) continue;
    
    const name = String(row[2] || '').trim();
    const brand = String(row[3] || '').trim();
    const code = normalizeCode(rawCode);
    
    // Prefer entries without -1 suffix (base code entries)
    // If we already have this code, prefer the one that was originally without -1
    if (!codes.has(code)) {
      codes.set(code, { code, name, brand, rawCode });
    } else {
      // If existing was from -1 variant and current is also -1, keep existing
      // If current is non-suffix version, it's the same code, keep first
    }
  }
  
  return codes;
}

function readFile2() {
  const wb = XLSX.readFile(FILE2_PATH);
  const ws = wb.Sheets[Object.keys(wb.Sheets)[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  
  const codes = new Map();
  
  // MXO section: rows 2-55 (after header at row 1)
  // PCMO section: rows 59-79 (after header at row 58)
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    
    const code = row[1];
    if (code == null || code === '' || typeof code === 'string' && code.match(/^(Mã|STT|Quà)/)) continue;
    if (typeof code !== 'number' && !String(code).match(/^\d{5,}$/)) continue;
    
    const name = String(row[2] || '').trim();
    if (!name) continue;
    
    const normalizedCode = normalizeCode(String(code));
    if (!codes.has(normalizedCode)) {
      codes.set(normalizedCode, { code: normalizedCode, name, brand: 'ZENTOR' });
    }
  }
  
  return codes;
}

// === STEP 2: Parse default-db.json ===
function parseDb() {
  const content = fs.readFileSync(DB_PATH, 'utf-8');
  const db = JSON.parse(content);
  return { content, db };
}

// === STEP 3: Extract all products from db ===
function extractProducts(db) {
  const products = [];
  
  for (const [campaignKey, campaign] of Object.entries(db.campaigns || {})) {
    if (!campaign.products) continue;
    for (const product of campaign.products) {
      products.push({
        id: product.id,
        name: product.name,
        spec: product.spec || '',
        packaging: product.packaging || '',
        unit: product.unit || '',
        campaign: campaignKey,
        brand: CAMPAIGN_BRAND[campaignKey] || campaignKey
      });
    }
  }
  
  return products;
}

// === STEP 4: Match KV codes to db.js products ===
function matchKvToProducts(kvCodes, dbProducts) {
  const matched = [];    // {kvCode, kvName, product}
  const unmatched = [];  // {code, name, brand}
  const ambiguous = [];  // {code, name, candidates}
  
  for (const [code, kvEntry] of kvCodes) {
    const kvBrand = normalizeStr(kvEntry.brand);
    const kvNameNorm = normalizeStr(kvEntry.name);
    const kvViscosity = extractViscosity(kvEntry.name);
    const kvVolume = extractVolume(kvEntry.name);
    const kvLine = extractProductLine(kvEntry.name);
    
    // Skip merchandise/non-product codes
    const isMerch = /polo|cap|raincoat|sticker|keyring|beachflag|canvas|display|áo|string bag|túi rút|nón|móc/i.test(kvEntry.name);
    
    // Find candidate products
    const candidates = [];
    
    for (const product of dbProducts) {
      const prodBrand = product.brand;
      const prodNameNorm = normalizeStr(product.name);
      const prodSpecNorm = normalizeStr(product.spec);
      const prodPackNorm = normalizeStr(product.packaging);
      
      // Brand check (must match)
      if (kvBrand !== prodBrand) continue;
      
      // Skip MKT gift products in db
      if (product.spec === 'Quà tặng MKT') continue;
      
      let score = 0;
      
      // Check product line match
      if (kvLine) {
        const prodLine = extractProductLine(product.name);
        if (prodLine && prodLine === kvLine) {
          score += 30;
        } else if (prodLine && kvLine && prodLine !== kvLine) {
          score -= 20; // Different product lines = unlikely match
        }
      }
      
      // Check viscosity match
      if (kvViscosity.length > 0) {
        const prodViscosity = extractViscosity(product.name + ' ' + product.spec);
        const viscosityMatch = kvViscosity.some(v => prodViscosity.some(pv => pv === v));
        if (viscosityMatch) {
          score += 25;
        } else if (prodViscosity.length > 0) {
          score -= 15;
        }
      }
      
      // Check volume match
      if (kvVolume) {
        const prodVolume = extractVolume(product.name + ' ' + product.packaging);
        if (prodVolume === kvVolume) {
          score += 20;
        } else if (prodVolume && prodVolume !== kvVolume) {
          // Volume mismatch is less penalizing (could be different packaging of same product)
          score -= 5;
        }
      }
      
      // Check name overlap (word-by-word)
      const kvWords = new Set(kvNameNorm.split(' ').filter(w => w.length > 2));
      const prodWords = prodNameNorm.split(' ').filter(w => w.length > 2);
      let overlap = 0;
      for (const w of prodWords) {
        if (kvWords.has(w)) overlap++;
      }
      if (prodWords.length > 0) {
        const overlapRatio = overlap / prodWords.length;
        score += Math.round(overlapRatio * 15);
      }
      
      if (score > 10) {
        candidates.push({ product, score });
      }
    }
    
    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);
    
    if (candidates.length === 0) {
      if (!isMerch) {
        unmatched.push(kvEntry);
      }
    } else if (candidates.length === 1 || candidates[0].score > candidates[1].score + 15) {
      // Clear winner
      matched.push({
        kvCode: code,
        kvName: kvEntry.name,
        product: candidates[0].product,
        score: candidates[0].score
      });
    } else {
      // Multiple close candidates - try volume disambiguation
      const topCandidates = candidates.filter(c => c.score >= candidates[0].score - 10);
      
      if (kvVolume) {
        const volumeMatch = topCandidates.filter(c => {
          const cv = extractVolume(c.product.name + ' ' + c.product.packaging);
          return cv === kvVolume;
        });
        if (volumeMatch.length === 1) {
          matched.push({
            kvCode: code,
            kvName: kvEntry.name,
            product: volumeMatch[0].product,
            score: volumeMatch[0].score
          });
          continue;
        }
      }
      
      // Still ambiguous - pick the best one but flag it
      matched.push({
        kvCode: code,
        kvName: kvEntry.name,
        product: topCandidates[0].product,
        score: topCandidates[0].score,
        isAmbiguous: true,
        allCandidates: topCandidates.map(c => c.product.id)
      });
    }
  }
  
  // Separate ambiguous from matched
  const cleanMatched = matched.filter(m => !m.isAmbiguous);
  const ambiguousMatches = matched.filter(m => m.isAmbiguous);
  
  return { matched: cleanMatched, ambiguous: ambiguousMatches, unmatched };
}

// === STEP 5: Patch default-db.json ===
function patchDb(db, matches, overrideMap) {
  let updatedCount = 0;
  const changes = [];
  
  // Build a map of product_id -> kvCode from auto-matched
  const kvMap = new Map();
  for (const m of matches) {
    const existing = kvMap.get(m.product.id);
    if (existing) continue;
    kvMap.set(m.product.id, m.kvCode);
  }
  
  // Apply manual overrides (these take priority)
  for (const [productId, kvCode] of overrideMap) {
    kvMap.set(productId, kvCode);
  }
  
  // Directly update kvCode on product objects in the JSON
  for (const [campaignKey, campaign] of Object.entries(db.campaigns || {})) {
    if (!campaign.products) continue;
    for (const product of campaign.products) {
      const kvCode = kvMap.get(product.id);
      if (kvCode) {
        if (product.kvCode && product.kvCode !== kvCode) {
          changes.push(`  UPDATE ${product.id}: "${product.kvCode}" -> "${kvCode}"`);
          product.kvCode = kvCode;
          updatedCount++;
        } else if (!product.kvCode) {
          product.kvCode = kvCode;
          updatedCount++;
          changes.push(`  ADD ${product.id} -> "${kvCode}"`);
        }
      }
    }
  }
  
  return { db, updatedCount, changes };
}

// === MAIN ===
function main() {
  console.log('=== KV Code Import Tool ===\n');
  
  // Step 1: Read Excel files
  console.log('Reading Excel files...');
  const file1Codes = readFile1();
  const file2Codes = readFile2();
  console.log(`  File 1 (Mã hàng hóa KV): ${file1Codes.size} unique codes`);
  console.log(`  File 2 (Zentor V5): ${file2Codes.size} unique codes`);
  
  // Step 2: Merge codes (File 2 preferred for Zentor names)
  const mergedCodes = new Map();
  
  // Add File 1 codes first
  for (const [code, entry] of file1Codes) {
    mergedCodes.set(code, entry);
  }
  
  // Override with File 2 codes (more complete Zentor names)
  for (const [code, entry] of file2Codes) {
    if (mergedCodes.has(code)) {
      // Prefer File 2 name for Zentor products
      mergedCodes.set(code, { ...mergedCodes.get(code), name: entry.name, brand: entry.brand });
    } else {
      mergedCodes.set(code, entry);
    }
  }
  
  console.log(`  Merged total: ${mergedCodes.size} unique KV codes\n`);
  
  // Step 3: Parse db.js
  console.log('Parsing db.js...');
  const { content, db } = parseDb();
  const dbProducts = extractProducts(db);
  console.log(`  Found ${dbProducts.length} products in db.js\n`);
  
  // Step 4: Match
  console.log('Matching KV codes to db.js products...');
  const { matched, ambiguous, unmatched } = matchKvToProducts(mergedCodes, dbProducts);
  
  // Also include ambiguous matches in the patch (best guess)
  const allMatches = [...matched, ...ambiguous];
  
  // Build manual override map
  const overrideMap = new Map();
  for (const [kvCode, productId] of Object.entries(MANUAL_OVERRIDES)) {
    if (mergedCodes.has(kvCode)) {
      overrideMap.set(productId, kvCode);
    }
  }
  
  console.log(`  Matched: ${matched.length}`);
  console.log(`  Ambiguous (best guess used): ${ambiguous.length}`);
  console.log(`  Manual overrides: ${overrideMap.size}`);
  console.log(`  Unmatched: ${unmatched.length}\n`);
  
  // Step 5: Patch default-db.json
  console.log('Patching default-db.json...');
  const { db: patchedDb, updatedCount, changes } = patchDb(db, allMatches, overrideMap);
  
  // Write back as formatted JSON
  fs.writeFileSync(DB_PATH, JSON.stringify(patchedDb, null, 2), 'utf-8');
  console.log(`  Updated ${updatedCount} products in default-db.json\n`);
  
  // Step 6: Report
  console.log('=== KV Code Import Report ===');
  console.log(`Source files: 2`);
  console.log(`Total KV codes found: ${mergedCodes.size} (unique)`);
  console.log(`Matched to db.js: ${matched.length}`);
  console.log(`Ambiguous (best-guess matched): ${ambiguous.length}`);
  console.log(`Unmatched: ${unmatched.length}`);
  console.log(`Updated in db.js: ${updatedCount} products`);
  
  if (unmatched.length > 0) {
    // Filter out codes that have manual overrides
    const realUnmatched = unmatched.filter(u => !MANUAL_OVERRIDES[u.code]);
    if (realUnmatched.length > 0) {
      console.log('\n--- Unmatched KV Codes ---');
      for (const u of realUnmatched) {
        console.log(`  [${u.brand}] ${u.code}: ${u.name}`);
      }
    }
  }
  
  if (ambiguous.length > 0) {
    console.log('\n--- Ambiguous Matches (review needed) ---');
    for (const a of ambiguous) {
      console.log(`  ${a.kvCode} "${a.kvName}" -> ${a.product.id} (candidates: ${a.allCandidates.join(', ')})`);
    }
  }
  
  if (changes.length > 0) {
    console.log('\n--- Changes Applied ---');
    for (const c of changes) {
      console.log(c);
    }
  }
  
  console.log('\nDone!');
}

main();
