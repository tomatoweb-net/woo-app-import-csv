require('dotenv').config();
const ftp = require("basic-ftp");
const csv = require("csv-parser");
const fs = require("fs");
const axios = require("axios");
const cliProgress = require("cli-progress");

const FTP_CONFIG = {
    host: process.env.FTP_HOST,
    user: process.env.FTP_USER,
    password: process.env.FTP_PASSWORD,
    secure: false
};

const CSV_FILE = process.env.CSV_LOCAL_FILE;

const WC_API_URL = process.env.WC_API_URL;
const WC_KEY = process.env.WC_KEY;
const WC_SECRET = process.env.WC_SECRET;

async function downloadCSV() {
    const client = new ftp.Client();
    try {
        await client.access(FTP_CONFIG);
        console.log("✅ Connesso all'FTP");
        await client.downloadTo(CSV_FILE, process.env.CSV_REMOTE_PATH);
        console.log("📥 CSV scaricato con successo");
    } catch (err) {
        console.error("❌ Errore FTP:", err);
    }
    client.close();
}

async function processCSVAndSync() {
    const records = [];

    fs.createReadStream(CSV_FILE)
        .pipe(csv({ separator: ";" }))
        .on("data", (row) => {
            records.push({
                ean: row["EAN13"] || row["sku"] || row["col5"],
                stock: row["Giacenza"] || row["giacenza"] || row["col4"]
            });
        })
        .on("end", async () => {
            console.log(`📋 Totale prodotti letti dal CSV: ${records.length}`);

            const progressBar = new cliProgress.SingleBar({
                format: 'Progress |{bar}| {percentage}% || {value}/{total} Prodotti aggiornati',
                barCompleteChar: '\u2588',
                barIncompleteChar: '\u2591',
                hideCursor: true
            });

            progressBar.start(records.length, 0);

            for (const product of records) {
                try {
                    const response = await axios.get(`${WC_API_URL}/products`, {
                        params: { sku: product.ean },
                        auth: {
                            username: WC_KEY,
                            password: WC_SECRET
                        }
                    });

                    const data = response.data;

                    if (!data.length) {
                        console.warn(`⚠️ Prodotto non trovato per SKU ${product.ean}`);
                        progressBar.increment();
                        continue;
                    }

                    const parentId = data[0].parent_id || data[0].id;
                    const variationId = data[0].id;

                    await axios.put(`${WC_API_URL}/products/${parentId}/variations/${variationId}`, {
                        manage_stock: true,
                        stock_quantity: product.stock
                    }, {
                        auth: {
                            username: WC_KEY,
                            password: WC_SECRET
                        }
                    });

                } catch (error) {
                    console.error(`❌ Errore su SKU ${product.ean}:`, error.response ? error.response.data : error.message);
                }

                progressBar.increment();
            }

            progressBar.stop();
            console.log("🎉 Sincronizzazione completata!");
        });
}

(async () => {
    await downloadCSV();
    await processCSVAndSync();
})();
