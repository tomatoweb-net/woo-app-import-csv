require('dotenv').config();
const ftp = require("basic-ftp");
const csv = require("csv-parser");
const fs = require("fs");
const axios = require("axios");
const cliProgress = require("cli-progress");
const path = require("path");

// ✅ CONFIGURAZIONE FTP
const FTP_CONFIG = {
    host: process.env.FTP_HOST,
    user: process.env.FTP_USER,
    password: process.env.FTP_PASSWORD,
    secure: false
};

// ✅ CONFIGURAZIONE WooCommerce API
const WC_API_URL = process.env.WC_API_URL;
const WC_KEY = process.env.WC_KEY;
const WC_SECRET = process.env.WC_SECRET;

// ✅ PERCORSI FILE
const CSV_FILE = process.env.CSV_LOCAL_FILE;  // Percorso dove scaricare il CSV
const ARCHIVE_FOLDER = path.join(__dirname, "archive");

// ✅ Scarica il file CSV da FTP
async function downloadCSV() {
    const client = new ftp.Client();
    try {
        await client.access(FTP_CONFIG);
        console.log("✅ Connesso all'FTP");

        await client.downloadTo(CSV_FILE, process.env.CSV_REMOTE_PATH);
        console.log("📥 CSV scaricato con successo in", CSV_FILE);
    } catch (err) {
        console.error("❌ Errore FTP:", err.message);
        throw err;  // Interrompe il processo in caso di errore
    } finally {
        client.close();
    }
}

// ✅ Processa il CSV e aggiorna WooCommerce
async function processCSVAndSync() {
    return new Promise((resolve, reject) => {
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
                            auth: { username: WC_KEY, password: WC_SECRET }
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
                            stock_quantity: parseInt(product.stock) || 0
                        }, {
                            auth: { username: WC_KEY, password: WC_SECRET }
                        });

                        console.log(`✅ Aggiornato SKU ${product.ean} con giacenza ${product.stock}`);
                    } catch (error) {
                        console.error(`❌ Errore su SKU ${product.ean}:`, error.response ? error.response.data : error.message);
                    }

                    progressBar.increment();
                }

                progressBar.stop();
                console.log("🎉 Sincronizzazione completata!");

                resolve(); // Termina la Promise dopo aver processato tutto
            })
            .on("error", (err) => {
                console.error("❌ Errore lettura CSV:", err.message);
                reject(err);
            });
    });
}

// ✅ Archivia il CSV dopo il processing
async function archiveCSV() {
    try {
        // Crea la cartella "archive" se non esiste
        if (!fs.existsSync(ARCHIVE_FOLDER)) {
            fs.mkdirSync(ARCHIVE_FOLDER);
        }

        // Nome file archiviato con timestamp
        const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
        const archivedFileName = `giacenze_${timestamp}.csv`;
        const archivedPath = path.join(ARCHIVE_FOLDER, archivedFileName);

        // Sposta il file originale nella cartella archive
        fs.renameSync(CSV_FILE, archivedPath);

        console.log(`🗃️ File archiviato come ${archivedFileName}`);
    } catch (err) {
        console.error("❌ Errore durante l'archiviazione del file CSV:", err.message);
        throw err;
    }
}

// ✅ WORKFLOW COMPLETO
(async () => {
    try {
        console.log("🚀 Inizio processo di sincronizzazione...");

        await downloadCSV();

        if (!fs.existsSync(CSV_FILE)) {
            console.error("❌ File CSV non trovato dopo il download. Processo interrotto.");
            return;
        }

        await processCSVAndSync();
        await archiveCSV();

        console.log("✅ Processo completato con successo!");
    } catch (error) {
        console.error("❌ Processo terminato con errore:", error.message);
    }
})();
