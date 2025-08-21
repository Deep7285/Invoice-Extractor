const WORKER_ENDPOINT = "https://invoice-worker.deepak72855.workers.dev"; // during local dev
// After deploy: const WORKER_ENDPOINT = "https://<your-worker>.workers.dev";

const MAX_PAGES = 10;
const JPEG_QUALITY = 0.7;
const TARGET_WIDTH = 1300;

const fileInput = document.getElementById("fileInput");
const runBtn = document.getElementById("runExtract");
const statusEl = document.getElementById("status");

async function fileToDataUrl(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.readAsDataURL(file);
  });
}

async function pdfToImages(file) {
  const dataUrl = await fileToDataUrl(file);
  const pdf = await pdfjsLib.getDocument({ url: dataUrl }).promise;
  const pages = Math.min(pdf.numPages, MAX_PAGES);

  const out = [];
  for (let p = 1; p <= pages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1.5 });
    const scale = TARGET_WIDTH / viewport.width;
    const vp = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);

    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const jpeg = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    out.push(jpeg);
  }
  return out;
}

async function imageToCompressedDataUrl(file) {
  const dataUrl = await fileToDataUrl(file);
  const img = new Image();
  await new Promise(res => { img.onload = res; img.src = dataUrl; });

  const scale = img.width > TARGET_WIDTH ? TARGET_WIDTH / img.width : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(img.width * scale);
  canvas.height = Math.floor(img.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

async function docxToText(file) {
  const arrayBuffer = await file.arrayBuffer();
  const result = await window.mammoth.extractRawText({ arrayBuffer });
  return result.value || "";
}

async function postToWorker({ imagesDataUrls = [], docText = "" }) {
  const form = new FormData();
  for (const d of imagesDataUrls) form.append("images_dataurl[]", d);
  if (docText && docText.trim()) form.append("doc_text", docText.trim());

  const resp = await fetch(`${WORKER_ENDPOINT}/api/extract`, { method: "POST", body: form });
  if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
  return resp.json();
}

function buildExcelRow(json, sourceName) {
  const seller = json?.seller ?? {};
  const invoice = json?.invoice ?? {};
  const amounts = json?.amounts ?? {};
  const taxes = Array.isArray(json?.taxes) ? json.taxes : [];

  const taxStr = taxes.map(t => {
    const rp = (t.rate_percent ?? "null");
    const amt = (t.amount ?? "null");
    return `${t.type} ${rp}%:${amt}`;
  }).join("; ");

  return {
    SELLER_NAME: seller.company_name || null,
    SELLER_GSTIN: seller.gstin || null,
    SELLER_ADDRESS: seller.address || null,
    INVOICE_NUMBER: invoice.number || null,
    INVOICE_DATE: invoice.date || null,
    TRANSACTION_ID: invoice.transaction_id || null,
    TAXABLE_AMOUNT: amounts.taxable_amount ?? null,
    TOTAL_AMOUNT: amounts.total_amount ?? null,
    TAX_BREAKDOWN: taxStr || null,
    SOURCE_FILE: sourceName || null
  };
}

function downloadExcel(rows, filename = "invoices_gpt.xlsx") {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Invoices");
  XLSX.writeFile(wb, filename);
}

runBtn?.addEventListener("click", async () => {
  try {
    statusEl.textContent = "Processing…";
    const files = Array.from(fileInput.files || []);
    if (!files.length) throw new Error("Select at least one file");

    const rows = [];
    for (const file of files) {
      statusEl.textContent = `Processing ${file.name}…`;
      let payload = { imagesDataUrls: [], docText: "" };

      if (file.type === "application/pdf") {
        payload.imagesDataUrls = await pdfToImages(file);
      } else if (file.type.startsWith("image/")) {
        payload.imagesDataUrls = [await imageToCompressedDataUrl(file)];
      } else if (file.name.toLowerCase().endsWith(".docx")) {
        payload.docText = await docxToText(file);
      } else {
        throw new Error(`Unsupported file: ${file.name}`);
      }

      const json = await postToWorker(payload);
      rows.push(buildExcelRow(json, file.name));
    }

    downloadExcel(rows);
    statusEl.textContent = "Done. Excel downloaded.";
  } catch (e) {
    console.error(e);
    statusEl.textContent = `Error: ${e.message}`;
  }
});
