const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

// Enable stealth plugin to prevent detection
puppeteer.use(StealthPlugin());

async function runScraper() {
  console.log("🚀 Starting Stealth Scraper V6 (Minimalist Edition)...");

  // 1. Authenticate with Google Sheets using the single JSON secret
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  
  const serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];
  
  // --- AUTO-EXPAND COLUMNS IF NEEDED ---
  // We only need 14 columns now (A through N)
  if (sheet.columnCount < 14) {
    console.log(`📏 Expanding sheet columns from ${sheet.columnCount} to 14...`);
    await sheet.resize({ rowCount: sheet.rowCount, columnCount: 14 });
  }

  // Load the cells so we can read and write to them anywhere
  await sheet.loadCells(); 

  // 2. Launch Headless Browser
  const browser = await puppeteer.launch({
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  let scrapeCount = 0;
  let rowsRemaining = false;

  // 3. Loop through rows (EXPLICIT START: rowIndex = 1 skips the header)
  for (let rowIndex = 1; rowIndex < sheet.rowCount; rowIndex++) {
    
    // Column A (0) and Column N (13)
    const url = sheet.getCell(rowIndex, 0).value;
    const status = sheet.getCell(rowIndex, 13).value || "";

    if (!url) {
      continue; // Skip empty rows
    }

    if (!url.includes("zillow.com") || status.includes("✅")) {
      continue; // Skip non-Zillow links or already scraped rows
    }

    // --- FRESH RUN LIMITER ---
    if (scrapeCount >= 30) {
      console.log("🛑 Reached 30 rows. Shutting down to grab a fresh IP...");
      rowsRemaining = true;
      break; 
    }

    const actualRowNumber = rowIndex + 1; 
    console.log(`🕵️ Scraping Row ${actualRowNumber}: ${url}`);
    
    sheet.getCell(rowIndex, 13).value = "🕵️ Mimicking Googlebot...";
    await sheet.saveUpdatedCells();

    const page = await browser.newPage();
    
    try {
      // --- SPEED BOOST: BLOCK HEAVY ASSETS ---
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
          req.abort(); 
        } else {
          req.continue();
        }
      });

      // Fast delay (0.5 to 1 second)
      await new Promise(r => setTimeout(r, Math.floor(Math.random() * 500) + 500));
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      const pageTitle = await page.title();
      if (pageTitle.includes("Pardon Our Interruption") || pageTitle.includes("Robot Check")) {
        sheet.getCell(rowIndex, 13).value = "❌ BLOCKED (IP Burned)";
        await sheet.saveUpdatedCells();
        await page.close();
        continue; 
      }

      // 4. Extract MINIMAL details from Next.js state
      const extractedData = await page.evaluate(() => {
        
        // ----- Helper: format property type -----
        const formatPropertyType = (rawType) => {
          if (!rawType) return "";
          return rawType
            .replace(/_/g, ' ')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .toLowerCase()
            .replace(/\b\w/g, char => char.toUpperCase());
        };

        // ----- Helper: extract from home detail -----
        const extractFromHomeDetail = (jsonData) => {
          let data = { addr: "", propertyType: "", desc: "", county: "" };

          const rawCache = jsonData?.props?.pageProps?.componentProps?.gdpClientCache;
          if (!rawCache) return data;

          try {
            const parsedCache = JSON.parse(rawCache);
            const cacheKey = Object.keys(parsedCache)[0];
            const p = parsedCache[cacheKey]?.property;
            if (!p) return data;

            data = {
              addr: p.address?.streetAddress || "",
              county: p.county || "",
              propertyType: formatPropertyType(p.homeType),
              desc: p.description || ""
            };
          } catch (e) { /* ignore */ }
          return data;
        };

        // ----- Helper: extract from rental building -----
        const extractFromRentalBuilding = (jsonData) => {
          let data = { addr: "", propertyType: "Apartment", desc: "", county: "" };

          const building = jsonData?.props?.pageProps?.componentProps?.initialReduxState?.gdp?.building;
          if (!building) return data;

          data.addr = building.streetAddress || "";
          data.county = building.county || "";
          data.desc = building.description || "";

          return data;
        };

        const nextDataScript = document.querySelector('script#__NEXT_DATA__');
        if (!nextDataScript) return {};

        let jsonData;
        try {
          jsonData = JSON.parse(nextDataScript.innerText);
        } catch (e) {
          return {};
        }

        let result = extractFromHomeDetail(jsonData);
        if (!result.addr) {
          result = extractFromRentalBuilding(jsonData);
        }
        return result;
      });

      // 5. Write Data Back to Sheets
      sheet.getCell(rowIndex, 9).value = extractedData.addr;             // J
      sheet.getCell(rowIndex, 10).value = extractedData.propertyType;    // K
      sheet.getCell(rowIndex, 11).value = extractedData.desc;            // L
      sheet.getCell(rowIndex, 12).value = extractedData.county;          // M
      sheet.getCell(rowIndex, 13).value = "✅ SUCCESS";                  // N

      await sheet.saveUpdatedCells();
      console.log(`✅ Success: Row ${actualRowNumber} | 🏠 ${extractedData.propertyType}`);
      scrapeCount++; 

    } catch (e) {
      console.error(`🛑 Error on Row ${actualRowNumber}: ${e.message}`);
      sheet.getCell(rowIndex, 13).value = "🛑 Error: " + e.message;
      await sheet.saveUpdatedCells();
    } finally {
      await page.close();
    }
  }

  await browser.close();

  if (process.env.GITHUB_OUTPUT) {
    if (rowsRemaining) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, "has_more=true\n");
    } else {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, "has_more=false\n");
      console.log("🎉 Entire sheet is complete!");
    }
  }
}

runScraper();
