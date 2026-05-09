const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const nodemailer = require("nodemailer");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

const execFileAsync = promisify(execFile);

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(".env");
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("Could not load .env file:", error.message);
    }
  }
}

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const PAYMENT_ATTEMPTS_FILE = path.join(DATA_DIR, "payment-attempts.json");
const TEMP_UPLOAD_DIR = path.join(DATA_DIR, "tmp");
const ORDER_ARTIFACTS_DIR = path.join(DATA_DIR, "artifacts");
const PDF_ANALYSIS_SCRIPT = path.join(ROOT, "pdf_analysis.py");
const PYTHON_EXECUTABLE = sanitizePythonExecutable(process.env.PYTHON_EXECUTABLE);
const PYTHON_EXECUTABLE_ARGS = process.env.PYTHON_EXECUTABLE
  ? []
  : process.platform === "win32"
    ? ["-3"]
    : [];
const PORT = Number(process.env.PORT || 3000);
const HOST = sanitizeText(process.env.HOST) || "0.0.0.0";
const MAX_PORT_FALLBACK_ATTEMPTS = 10;
const PDF_ANALYSIS_TIMEOUT_MS = Number(process.env.PDF_ANALYSIS_TIMEOUT_MS || 45000);
const PDF_CONVERSION_TIMEOUT_MS = Number(process.env.PDF_CONVERSION_TIMEOUT_MS || 180000);
const BUSINESS_NAME = process.env.BUSINESS_NAME || "Rahul Prints";
const BUSINESS_EMAIL = sanitizeText(process.env.BUSINESS_EMAIL) || sanitizeText(process.env.SMTP_USER) || "owner@example.com";
const ORDER_NOTIFICATION_EMAIL = process.env.ORDER_NOTIFICATION_EMAIL || BUSINESS_EMAIL;
const BUSINESS_PHONE = process.env.BUSINESS_PHONE || "+919345574203";
const UPI_ID = process.env.UPI_ID || "rahulsiva190@okicici";
const UPI_PAYEE_NAME = sanitizeText(process.env.UPI_PAYEE_NAME) || "Rahul Siva";
const UPI_MERCHANT_CODE = sanitizeText(process.env.UPI_MERCHANT_CODE);
const PRICE_BW = Number(process.env.PRICE_BW || 1);
const PRICE_COLOR = Number(process.env.PRICE_COLOR || 10);
const PAYMENT_TIMEOUT_MINUTES = Number(process.env.PAYMENT_TIMEOUT_MINUTES || 5);
const MAIL_PROVIDER = resolveMailProvider();
const SMTP_SERVICE = sanitizeText(process.env.SMTP_SERVICE);
const SMTP_HOST = sanitizeText(process.env.SMTP_HOST);
const SMTP_PORT = resolveSmtpPort();
const SMTP_SECURE = resolveOptionalBoolean(process.env.SMTP_SECURE);
const MAX_FORWARDABLE_PDF_MB = resolveMaxForwardablePdfMb(MAIL_PROVIDER);
const MAX_REQUEST_BODY_BYTES = Number(
  process.env.MAX_REQUEST_BODY_BYTES ||
    Math.ceil(MAX_FORWARDABLE_PDF_MB * 1024 * 1024 * 1.45 + 1.5 * 1024 * 1024)
);
const DRY_RUN_NOTIFICATIONS = String(process.env.DRY_RUN_NOTIFICATIONS || "").toLowerCase() === "true";
const MAIL_FROM_EMAIL = sanitizeText(process.env.MAIL_FROM_EMAIL) || sanitizeText(process.env.SMTP_USER) || BUSINESS_EMAIL;
const MAIL_FROM_NAME = sanitizeText(process.env.MAIL_FROM_NAME) || BUSINESS_NAME;
const MJ_APIKEY_PUBLIC = sanitizeText(process.env.MJ_APIKEY_PUBLIC);
const MJ_APIKEY_PRIVATE = sanitizeText(process.env.MJ_APIKEY_PRIVATE);
const MAILJET_API_BASE = sanitizeText(process.env.MAILJET_API_BASE) || "https://api.mailjet.com/v3.1/send";
const RAZORPAY_KEY_ID = sanitizeText(process.env.RAZORPAY_KEY_ID);
const RAZORPAY_KEY_SECRET = sanitizeText(process.env.RAZORPAY_KEY_SECRET);
const RAZORPAY_API_BASE = sanitizeText(process.env.RAZORPAY_API_BASE) || "https://api.razorpay.com/v1";

const STATIC_FILES = {
  "/": "rahul-prints-pro-with-email.html",
  "/app.js": "app.js",
  "/styles.css": "styles.css",
  "/favicon.ico": null,
};

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};
const PAYMENT_ATTEMPT_STATUSES = new Set([
  "initiated",
  "launching",
  "app-opened",
  "returned",
  "success-selected",
  "failed-selected",
  "pending-selected",
  "confirmation-submitted",
  "confirmed",
  "confirmation-error",
  "expired",
  "cancelled",
]);

let transporter = null;
const smtpTransportOptions = buildSmtpTransportOptions();

if (MAIL_PROVIDER === "smtp" && smtpTransportOptions) {
  transporter = nodemailer.createTransport(smtpTransportOptions);

  transporter.verify().then(
    () => {
      console.log("SMTP connection verified.");
    },
    (error) => {
      console.warn("SMTP verify failed:", error.message);
    }
  );
} else if (MAIL_PROVIDER === "smtp") {
  console.warn(
    "SMTP credentials are missing. Set SMTP_USER and SMTP_PASS, then optionally add SMTP_SERVICE or SMTP_HOST/SMTP_PORT/SMTP_SECURE."
  );
} else if (MAIL_PROVIDER === "mailjet") {
  if (!MJ_APIKEY_PUBLIC || !MJ_APIKEY_PRIVATE) {
    console.warn("Mailjet API credentials are missing. Email sending will fail until .env is configured.");
  } else {
    console.log("Mail provider configured: Mailjet API.");
    if (isFreemailSenderAddress(MAIL_FROM_EMAIL)) {
      console.warn(
        "Mailjet is using a free webmail sender address. Gmail/Outlook/Yahoo sender addresses often fail DMARC checks or land in spam. Prefer SMTP for local testing or a verified custom domain sender for Mailjet."
      );
    }
  }
} else {
  console.warn("Email delivery is not configured. Set MAIL_PROVIDER to mailjet or smtp before deploying.");
}

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.warn("Razorpay is not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET before accepting online payments.");
}

Promise.all([ensureOrdersStore(), ensurePaymentAttemptsStore()]).catch((error) => {
  console.warn("Data store initialization failed:", error.message);
});

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": CONTENT_TYPES[".json"],
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function serveFile(response, pathname) {
  const fileName = STATIC_FILES[pathname];

  if (fileName === null) {
    response.writeHead(204);
    response.end();
    return;
  }

  if (!fileName) {
    sendJson(response, 404, { success: false, error: "Not found." });
    return;
  }

  const absolutePath = path.join(ROOT, fileName);
  const extension = path.extname(absolutePath);

  fs.readFile(absolutePath, (error, data) => {
    if (error) {
      sendJson(response, 500, { success: false, error: "Unable to load static file." });
      return;
    }

    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extension] || "application/octet-stream",
      "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=300",
    });
    response.end(data);
  });
}

async function handleUpiQrRequest(response, requestUrl) {
  const qrPayload = sanitizeText(requestUrl.searchParams.get("data"));

  if (!qrPayload) {
    sendJson(response, 400, {
      success: false,
      error: "Missing UPI QR payload.",
    });
    return;
  }

  if (qrPayload.length > 4096) {
    sendJson(response, 400, {
      success: false,
      error: "UPI QR payload is too large.",
    });
    return;
  }

  try {
    const svg = await QRCode.toString(qrPayload, {
      type: "svg",
      width: 220,
      margin: 1,
      errorCorrectionLevel: "H",
      color: {
        dark: "#10203a",
        light: "#ffffff",
      },
    });

    response.writeHead(200, {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(svg);
  } catch (error) {
    sendJson(response, 500, {
      success: false,
      error: "Unable to generate the UPI QR code.",
    });
  }
}

async function handlePaymentAttemptStart(response, payload) {
  try {
    const record = await upsertPaymentAttemptRecord(payload);
    sendJson(response, 200, {
      success: true,
      attempt: record,
    });
  } catch (error) {
    sendJson(response, error.statusCode || 400, {
      success: false,
      error: error.message || "Could not register the payment attempt.",
    });
  }
}

async function handlePaymentAttemptUpdate(response, payload) {
  try {
    const updated = await updatePaymentAttemptStatus(payload?.attemptId, payload?.status, payload);
    sendJson(response, 200, {
      success: true,
      attempt: updated,
    });
  } catch (error) {
    sendJson(response, error.statusCode || 400, {
      success: false,
      error: error.message || "Could not update the payment attempt.",
    });
  }
}

async function handleRazorpayOrderRequest(response, payload) {
  try {
    const checkout = await createRazorpayOrderForOrder(payload);
    sendJson(response, 200, {
      success: true,
      ...checkout,
    });
  } catch (error) {
    sendJson(response, error.statusCode || 400, {
      success: false,
      error: error.message || "Could not start Razorpay checkout.",
    });
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";

    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_REQUEST_BODY_BYTES) {
        reject(
          new Error(
            `Request body is too large. Keep uploaded PDFs below ${MAX_FORWARDABLE_PDF_MB} MB before confirming payment.`
          )
        );
        request.destroy();
      }
    });

    request.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON payload."));
      }
    });

    request.on("error", (error) => reject(error));
  });
}

function readRequestBuffer(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    request.on("data", (chunk) => {
      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bufferChunk.length;

      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        reject(
          new Error(
            `Request body is too large. Keep uploaded PDFs below ${MAX_FORWARDABLE_PDF_MB} MB before confirming payment.`
          )
        );
        request.destroy();
        return;
      }

      chunks.push(bufferChunk);
    });

    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", (error) => reject(error));
  });
}

function sanitizeText(value, fallback = "") {
  return String(value || fallback).trim();
}

function isFreemailSenderAddress(email) {
  const domain = sanitizeText(email).split("@")[1]?.toLowerCase();
  return [
    "gmail.com",
    "googlemail.com",
    "hotmail.com",
    "outlook.com",
    "live.com",
    "yahoo.com",
    "ymail.com",
    "aol.com",
    "icloud.com",
  ].includes(domain);
}

function resolveMailProvider() {
  const configuredProvider = sanitizeText(process.env.MAIL_PROVIDER).toLowerCase();
  if (configuredProvider) {
    return configuredProvider;
  }

  if (process.env.MJ_APIKEY_PUBLIC && process.env.MJ_APIKEY_PRIVATE) {
    return "mailjet";
  }

  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    return "smtp";
  }

  return "";
}

function resolveOptionalBoolean(value) {
  const normalized = sanitizeText(value).toLowerCase();
  if (!normalized) {
    return null;
  }

  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }

  return null;
}

function resolveSmtpPort() {
  const parsed = Number(process.env.SMTP_PORT);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function buildSmtpTransportOptions() {
  const user = sanitizeText(process.env.SMTP_USER);
  const pass = sanitizeText(process.env.SMTP_PASS);

  if (!user || !pass) {
    return null;
  }

  if (SMTP_HOST) {
    const secure = SMTP_SECURE ?? SMTP_PORT === 465;
    return {
      host: SMTP_HOST,
      port: SMTP_PORT || (secure ? 465 : 587),
      secure,
      auth: { user, pass },
    };
  }

  if (SMTP_SERVICE) {
    return {
      service: SMTP_SERVICE,
      auth: { user, pass },
    };
  }

  return {
    service: "gmail",
    auth: { user, pass },
  };
}

function resolveMaxForwardablePdfMb(mailProvider) {
  const configuredLimitMb = Number(process.env.MAX_FORWARDABLE_PDF_MB || 18);

  if (mailProvider === "mailjet") {
    const mailjetSafeLimitMb = Number(process.env.EMAIL_ATTACHMENT_SAFE_MB || 10);
    return Math.max(1, Math.min(configuredLimitMb, mailjetSafeLimitMb));
  }

  return configuredLimitMb;
}

function sanitizePythonExecutable(value) {
  const configured = sanitizeText(value);
  if (configured) {
    return configured;
  }

  return process.platform === "win32" ? "py" : "python3";
}

function sanitizeFileName(value, fallback = "document.pdf") {
  const cleaned = String(value || fallback)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ");

  if (!cleaned) {
    return fallback;
  }

  return /\.pdf$/i.test(cleaned) ? cleaned : `${cleaned}.pdf`;
}

function sanitizeTransactionId(value) {
  return sanitizeText(value).replace(/\s+/g, "").toUpperCase();
}

function sanitizeUpiId(value) {
  return sanitizeText(value).replace(/\s+/g, "").toLowerCase();
}

function decodeHeaderValue(value, fallback = "") {
  const raw = sanitizeText(value, fallback);
  if (!raw) {
    return fallback;
  }

  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function isValidTransactionId(value) {
  return /^[A-Z0-9._-]{8,40}$/.test(value);
}

function isValidUpiId(value) {
  return /^[a-z0-9._-]{2,}@[a-z][a-z0-9.-]{1,}$/i.test(value);
}

function isValidRazorpayReference(value, expectedPrefix = "") {
  const normalized = sanitizeText(value);
  if (!/^[A-Za-z0-9_]{10,80}$/.test(normalized)) {
    return false;
  }

  return expectedPrefix ? normalized.startsWith(`${expectedPrefix}_`) : true;
}

function isValidRazorpaySignature(value) {
  return /^[a-f0-9]{64}$/i.test(sanitizeText(value));
}

function formatCurrency(amount) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(Number(amount || 0));
}

function formatDateTime(value) {
  const formatter = new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: true,
  });
  return formatter.format(new Date(value));
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlToPlainText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<li>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function buildMailjetRecipients(addresses) {
  return addresses.map((address) => ({
    Email: address.email,
    Name: address.name || address.email,
  }));
}

function buildMailjetAttachments(attachments) {
  return attachments.map((attachment) => ({
    ContentType: attachment.contentType || "application/octet-stream",
    Filename: attachment.filename,
    Base64Content: Buffer.isBuffer(attachment.content)
      ? attachment.content.toString("base64")
      : Buffer.from(String(attachment.content || ""), "utf8").toString("base64"),
  }));
}

async function sendMailjetEmail({ to, subject, html, attachments = [] }) {
  if (!MJ_APIKEY_PUBLIC || !MJ_APIKEY_PRIVATE) {
    const error = new Error("Mailjet is not configured. Add MJ_APIKEY_PUBLIC and MJ_APIKEY_PRIVATE to .env.");
    error.statusCode = 500;
    throw error;
  }

  const response = await fetch(MAILJET_API_BASE, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${MJ_APIKEY_PUBLIC}:${MJ_APIKEY_PRIVATE}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      Messages: [
        {
          From: {
            Email: MAIL_FROM_EMAIL,
            Name: MAIL_FROM_NAME,
          },
          To: buildMailjetRecipients(Array.isArray(to) ? to : [to]),
          Subject: subject,
          HTMLPart: html,
          TextPart: htmlToPlainText(html),
          ReplyTo: {
            Email: BUSINESS_EMAIL,
            Name: BUSINESS_NAME,
          },
          Attachments: buildMailjetAttachments(attachments),
        },
      ],
    }),
  });

  const responseText = await response.text();
  let parsedResponse = null;

  try {
    parsedResponse = responseText ? JSON.parse(responseText) : null;
  } catch {
    parsedResponse = null;
  }

  if (!response.ok) {
    const details =
      parsedResponse?.Messages?.[0]?.Errors?.map((item) => item?.ErrorMessage || item?.ErrorIdentifier).filter(Boolean).join(" | ") ||
      parsedResponse?.ErrorMessage ||
      responseText ||
      response.statusText;
    const error = new Error(`Mailjet delivery failed: ${details}`);
    error.statusCode = 502;
    throw error;
  }

  const messageResult = parsedResponse?.Messages?.[0];
  if (messageResult?.Status && String(messageResult.Status).toLowerCase() !== "success") {
    const details =
      messageResult?.Errors?.map((item) => item?.ErrorMessage || item?.ErrorIdentifier).filter(Boolean).join(" | ") ||
      "Unknown Mailjet delivery error.";
    const error = new Error(`Mailjet delivery failed: ${details}`);
    error.statusCode = 502;
    throw error;
  }

  return parsedResponse;
}

function isPdfBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 5 && buffer.subarray(0, 5).toString() === "%PDF-";
}

function getPaymentMethodLabel(order) {
  if (order.payment.method === "cod") {
    return "Cash on Pickup";
  }
  if (order.payment.method === "razorpay") {
    return "Online Payment via Razorpay";
  }
  return "UPI";
}

function getPaymentStatusLabel(order) {
  return order.payment.method === "cod" ? "Payment Pending - Cash on Pickup" : "Payment Successful";
}

function getPrintModeLabel(order) {
  return order.document?.printMode === "bw-only"
    ? "Black & White only"
    : order.document?.colorPages > 0
      ? "Original color mix"
      : "Black & White";
}

function createOrderId() {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const random = Math.floor(Math.random() * 900 + 100);
  return `RP${stamp}${random}`;
}

async function ensureOrdersStore() {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.promises.access(ORDERS_FILE, fs.constants.F_OK);
  } catch {
    await fs.promises.writeFile(ORDERS_FILE, "[]", "utf8");
  }
}

async function loadStoredOrders() {
  await ensureOrdersStore();
  const raw = await fs.promises.readFile(ORDERS_FILE, "utf8");
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveStoredOrder(orderRecord) {
  const orders = await loadStoredOrders();
  orders.push(orderRecord);
  await fs.promises.writeFile(ORDERS_FILE, JSON.stringify(orders, null, 2), "utf8");
}

async function ensurePaymentAttemptsStore() {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.promises.access(PAYMENT_ATTEMPTS_FILE, fs.constants.F_OK);
  } catch {
    await fs.promises.writeFile(PAYMENT_ATTEMPTS_FILE, "[]", "utf8");
  }
}

async function loadPaymentAttempts() {
  await ensurePaymentAttemptsStore();
  const raw = await fs.promises.readFile(PAYMENT_ATTEMPTS_FILE, "utf8");
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function savePaymentAttempts(attempts) {
  await ensurePaymentAttemptsStore();
  await fs.promises.writeFile(PAYMENT_ATTEMPTS_FILE, JSON.stringify(attempts, null, 2), "utf8");
}

function sanitizePaymentAttemptStatus(value) {
  const normalized = sanitizeText(value).toLowerCase();
  return PAYMENT_ATTEMPT_STATUSES.has(normalized) ? normalized : "initiated";
}

function normalisePaymentAttemptPayload(payload) {
  const record = payload && typeof payload === "object" ? payload : {};
  const attemptId = sanitizeText(record.attemptId);
  const orderId = sanitizeText(record.orderId);
  const status = sanitizePaymentAttemptStatus(record.status);
  const amount = Number(record.amount || 0);

  if (!attemptId) {
    const error = new Error("Payment attempt ID is required.");
    error.statusCode = 400;
    throw error;
  }

  if (!orderId) {
    const error = new Error("Order ID is required for payment attempt tracking.");
    error.statusCode = 400;
    throw error;
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    const error = new Error("A valid payment amount is required for payment attempt tracking.");
    error.statusCode = 400;
    throw error;
  }

  return {
    attemptId,
    orderId,
    appKey: sanitizeText(record.appKey),
    appLabel: sanitizeText(record.appLabel),
    amount,
    upiId: sanitizeText(record.upiId) || UPI_ID,
    payeeName: sanitizeText(record.payeeName) || UPI_PAYEE_NAME,
    upiLink: sanitizeText(record.upiLink),
    status,
    reason: sanitizeText(record.reason),
    transactionId: sanitizeTransactionId(record.transactionId),
    payerUpiId: sanitizeUpiId(record.payerUpiId),
    createdAt: sanitizeText(record.createdAt) || new Date().toISOString(),
    updatedAt: sanitizeText(record.updatedAt) || new Date().toISOString(),
    expiresAt: sanitizeText(record.expiresAt),
    browserInfo: sanitizeText(record.browserInfo),
  };
}

async function upsertPaymentAttemptRecord(payload) {
  const normalized = normalisePaymentAttemptPayload(payload);
  const attempts = await loadPaymentAttempts();
  const existingIndex = attempts.findIndex((entry) => sanitizeText(entry?.attemptId) === normalized.attemptId);
  const existing = existingIndex >= 0 ? attempts[existingIndex] : null;
  const nextRecord = {
    ...(existing || {}),
    ...normalized,
    createdAt: existing?.createdAt || normalized.createdAt,
    updatedAt: new Date().toISOString(),
  };

  if (existingIndex >= 0) {
    attempts[existingIndex] = nextRecord;
  } else {
    attempts.push(nextRecord);
  }

  await savePaymentAttempts(attempts);
  return nextRecord;
}

async function updatePaymentAttemptStatus(attemptId, status, extras = {}) {
  const attempts = await loadPaymentAttempts();
  const index = attempts.findIndex((entry) => sanitizeText(entry?.attemptId) === sanitizeText(attemptId));

  if (index < 0) {
    const error = new Error("Payment attempt was not found.");
    error.statusCode = 404;
    throw error;
  }

  const existing = attempts[index];
  attempts[index] = {
    ...existing,
    status: sanitizePaymentAttemptStatus(status),
    appLabel: sanitizeText(extras.appLabel) || existing.appLabel || "",
    reason: sanitizeText(extras.reason) || existing.reason || "",
    transactionId: sanitizeTransactionId(extras.transactionId) || existing.transactionId || "",
    payerUpiId: sanitizeUpiId(extras.payerUpiId) || existing.payerUpiId || "",
    confirmationMessage: sanitizeText(extras.confirmationMessage) || existing.confirmationMessage || "",
    updatedAt: new Date().toISOString(),
  };

  await savePaymentAttempts(attempts);
  return attempts[index];
}

function sanitizeOrderDirectoryName(value) {
  return sanitizeText(value, "order").replace(/[^a-z0-9_-]+/gi, "-");
}

function calculatePricing(document) {
  const bwPages = Number(document?.bwPages || 0);
  const colorPages = Number(document?.colorPages || 0);
  const totalPages = Number(document?.totalPages || 0);
  const copies = Number(document?.copies || 0);
  const bwCostPerCopy = bwPages * PRICE_BW;
  const colorCostPerCopy = colorPages * PRICE_COLOR;
  const pricePerCopy = bwCostPerCopy + colorCostPerCopy;
  const totalAmount = pricePerCopy * copies;

  return {
    bwPages,
    colorPages,
    totalPages,
    copies,
    bwCostPerCopy,
    colorCostPerCopy,
    pricePerCopy,
    totalAmount,
  };
}

function normaliseOrder(payload) {
  const order = payload && typeof payload === "object" ? payload : {};
  const payment = order.payment && typeof order.payment === "object" ? order.payment : {};
  const computed = calculatePricing(order.document);

  const normalized = {
    orderId: sanitizeText(order.orderId) || createOrderId(),
    createdAt: sanitizeText(order.createdAt) || new Date().toISOString(),
    customer: {
      name: sanitizeText(order.customer?.name),
      phone: sanitizeText(order.customer?.phone),
      email: sanitizeText(order.customer?.email),
    },
    document: {
      fileName: sanitizeFileName(order.document?.fileName),
      pagesLabel: sanitizeText(order.document?.pagesLabel),
      totalPages: computed.totalPages,
      copies: computed.copies,
      paperSize: sanitizeText(order.document?.paperSize),
      notes: sanitizeText(order.document?.notes),
      colorType: sanitizeText(order.document?.colorType) || "mixed",
      bwPages: computed.bwPages,
      colorPages: computed.colorPages,
      originalBwPages: Number(order.document?.originalBwPages || computed.bwPages),
      originalColorPages: Number(order.document?.originalColorPages || computed.colorPages),
      bwCostPerCopy: computed.bwCostPerCopy,
      colorCostPerCopy: computed.colorCostPerCopy,
      pricePerCopy: computed.pricePerCopy,
      printMode: sanitizeText(order.document?.printMode) || "original",
      convertedToBw: Boolean(order.document?.convertedToBw),
      savingsPerCopy: Number(order.document?.savingsPerCopy || 0),
    },
    amount: computed.totalAmount,
    payment: {
      method: sanitizeText(payment.method),
      app: sanitizeText(payment.app),
      transactionId: sanitizeTransactionId(payment.transactionId),
      payerUpiId: sanitizeUpiId(payment.payerUpiId),
      paidAt: sanitizeText(payment.paidAt) || new Date().toISOString(),
      upiLink: sanitizeText(payment.upiLink),
      razorpayOrderId: sanitizeText(payment.razorpayOrderId),
      razorpayPaymentId: sanitizeText(payment.razorpayPaymentId),
      razorpaySignature: sanitizeText(payment.razorpaySignature),
      attemptId: sanitizeText(payment.attemptId),
      customerReportedStatus: sanitizePaymentAttemptStatus(payment.customerReportedStatus || "success-selected"),
      failureReason: sanitizeText(payment.failureReason),
      verificationStatus: sanitizeText(payment.verificationStatus),
    },
  };

  if (!normalized.document.pagesLabel) {
    normalized.document.pagesLabel = normalized.document.printMode === "bw-only"
      ? `${normalized.document.totalPages} total (all pages converted to B/W for printing)`
      : `${normalized.document.totalPages} total (${normalized.document.bwPages} B/W + ${normalized.document.colorPages} Color)`;
  }

  if (!["original", "bw-only"].includes(normalized.document.printMode)) {
    normalized.document.printMode = "original";
  }

  const errors = [];

  if (!normalized.customer.name) errors.push("Customer name is required.");
  if (!normalized.customer.phone) errors.push("Customer phone is required.");
  if (!normalized.customer.email) errors.push("Customer email is required.");
  if (!normalized.document.fileName) errors.push("Document file name is required.");
  if (!normalized.document.paperSize) errors.push("Paper size is required.");
  if (!normalized.document.copies || normalized.document.copies < 1) errors.push("Copies must be at least 1.");
  if (!normalized.document.totalPages || normalized.document.totalPages < 1) errors.push("PDF page analysis is required.");
  if (normalized.document.totalPages !== normalized.document.bwPages + normalized.document.colorPages) {
    errors.push("The total page count does not match the detected black and white plus color page counts.");
  }

  const payloadAmount = Number(order.amount || 0);
  if (payloadAmount <= 0) {
    errors.push("Order amount must be greater than 0.");
  } else if (Math.abs(payloadAmount - normalized.amount) > 0.009) {
    errors.push("The submitted payment amount does not match the detected PDF pricing.");
  }

  if (normalized.payment.method === "upi") {
    if (!normalized.payment.transactionId) errors.push("UPI transaction ID is required.");
    if (!normalized.payment.payerUpiId) errors.push("Payer UPI ID is required.");
    if (!isValidTransactionId(normalized.payment.transactionId)) {
      errors.push("UPI transaction ID format is invalid.");
    }
    if (!isValidUpiId(normalized.payment.payerUpiId)) {
      errors.push("Payer UPI ID format is invalid.");
    }
    if (["failed-selected", "pending-selected"].includes(normalized.payment.customerReportedStatus)) {
      errors.push("The payment app still shows the payment as failed or pending. Retry the payment before confirming.");
    }
    normalized.payment.verificationStatus = "transaction-details-captured";
  } else if (normalized.payment.method === "razorpay") {
    if (!normalized.payment.razorpayOrderId) errors.push("Razorpay order ID is required.");
    if (!normalized.payment.razorpayPaymentId) errors.push("Razorpay payment ID is required.");
    if (!normalized.payment.razorpaySignature) errors.push("Razorpay payment signature is required.");
    if (!isValidRazorpayReference(normalized.payment.razorpayOrderId, "order")) {
      errors.push("Razorpay order ID format is invalid.");
    }
    if (!isValidRazorpayReference(normalized.payment.razorpayPaymentId, "pay")) {
      errors.push("Razorpay payment ID format is invalid.");
    }
    if (!isValidRazorpaySignature(normalized.payment.razorpaySignature)) {
      errors.push("Razorpay signature format is invalid.");
    }
    normalized.payment.transactionId = normalized.payment.razorpayPaymentId;
    normalized.payment.app = normalized.payment.app || "Razorpay Checkout";
    normalized.payment.verificationStatus = "gateway-signature-pending";
  } else if (normalized.payment.method === "cod") {
    normalized.payment.verificationStatus = "pickup-payment";
  } else {
    errors.push("Unsupported payment method.");
  }

  if (errors.length > 0) {
    const error = new Error(errors.join(" "));
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function normaliseOrderDraft(payload) {
  const order = payload && typeof payload === "object" ? payload : {};
  return normaliseOrder({
    ...order,
    payment: {
      method: "cod",
    },
  });
}

function isRazorpayConfigured() {
  return Boolean(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);
}

function toRazorpaySubunits(amount) {
  return Math.round(Number(amount || 0) * 100);
}

function buildRazorpayReceipt(orderId) {
  return sanitizeText(orderId).slice(0, 40);
}

async function requestRazorpayJson(pathname, options = {}) {
  if (!isRazorpayConfigured()) {
    const error = new Error("Razorpay is not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET before taking online payments.");
    error.statusCode = 503;
    throw error;
  }

  const requestUrl = `${RAZORPAY_API_BASE.replace(/\/+$/, "")}/${String(pathname || "").replace(/^\/+/, "")}`;
  const response = await fetch(requestUrl, {
    method: options.method || "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64")}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const raw = await response.text();
  let parsed = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {
      message: raw,
    };
  }

  if (!response.ok) {
    const error = new Error(
      parsed?.error?.description ||
      parsed?.description ||
      parsed?.message ||
      `Razorpay request failed with status ${response.status}.`
    );
    error.statusCode = response.status;
    throw error;
  }

  return parsed;
}

async function createRazorpayOrderForOrder(orderDraft) {
  const normalized = normaliseOrderDraft(orderDraft);
  const receipt = buildRazorpayReceipt(normalized.orderId);
  const amount = toRazorpaySubunits(normalized.amount);

  if (amount <= 0) {
    const error = new Error("Order amount must be greater than 0 before opening Razorpay checkout.");
    error.statusCode = 400;
    throw error;
  }

  const gatewayOrder = await requestRazorpayJson("/orders", {
    method: "POST",
    body: {
      amount,
      currency: "INR",
      receipt,
      notes: {
        appOrderId: normalized.orderId,
        documentName: normalized.document.fileName.slice(0, 200),
        customerName: normalized.customer.name.slice(0, 80),
      },
    },
  });

  return {
    keyId: RAZORPAY_KEY_ID,
    razorpayOrderId: sanitizeText(gatewayOrder.id),
    amount: Number(gatewayOrder.amount || amount),
    currency: sanitizeText(gatewayOrder.currency) || "INR",
    receipt: sanitizeText(gatewayOrder.receipt) || receipt,
    orderId: normalized.orderId,
  };
}

function assertValidRazorpaySignature(order) {
  const generated = crypto
    .createHmac("sha256", RAZORPAY_KEY_SECRET)
    .update(`${order.payment.razorpayOrderId}|${order.payment.razorpayPaymentId}`)
    .digest("hex");

  const provided = sanitizeText(order.payment.razorpaySignature).toLowerCase();
  const expected = sanitizeText(generated).toLowerCase();

  if (provided.length !== expected.length) {
    const error = new Error("Razorpay payment signature did not match.");
    error.statusCode = 400;
    throw error;
  }

  if (!crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    const error = new Error("Razorpay payment signature did not match.");
    error.statusCode = 400;
    throw error;
  }
}

async function verifyRazorpayPayment(order) {
  assertValidRazorpaySignature(order);
  const payment = await requestRazorpayJson(`/payments/${encodeURIComponent(order.payment.razorpayPaymentId)}`);

  if (sanitizeText(payment.order_id) !== order.payment.razorpayOrderId) {
    const error = new Error("The Razorpay payment did not belong to the created Razorpay order.");
    error.statusCode = 409;
    throw error;
  }

  if (Number(payment.amount || 0) !== toRazorpaySubunits(order.amount)) {
    const error = new Error("The Razorpay payment amount did not match the detected PDF pricing.");
    error.statusCode = 409;
    throw error;
  }

  if (sanitizeText(payment.currency) !== "INR") {
    const error = new Error("The Razorpay payment currency was not INR.");
    error.statusCode = 409;
    throw error;
  }

  if (sanitizeText(payment.status) !== "captured") {
    const error = new Error(
      sanitizeText(payment.status) === "authorized"
        ? "Razorpay shows the payment as authorized but not captured yet. Enable auto-capture in Razorpay, wait a moment, and try again."
        : `Razorpay shows the payment as ${sanitizeText(payment.status, "not captured")}. Only captured payments can confirm the order.`
    );
    error.statusCode = 409;
    throw error;
  }

  const capturedAt = Number(payment.captured_at || 0);
  const createdAt = Number(payment.created_at || 0);
  const paidAt = capturedAt > 0
    ? new Date(capturedAt * 1000).toISOString()
    : createdAt > 0
      ? new Date(createdAt * 1000).toISOString()
      : new Date().toISOString();
  const gatewayMethod = sanitizeText(payment.method);
  const gatewayVpa = sanitizeUpiId(payment.vpa);

  return {
    paymentId: sanitizeText(payment.id),
    orderId: sanitizeText(payment.order_id),
    status: sanitizeText(payment.status),
    method: gatewayMethod || "online",
    vpa: gatewayVpa,
    email: sanitizeText(payment.email),
    contact: sanitizeText(payment.contact),
    paidAt,
    appLabel: gatewayMethod ? `Razorpay Checkout (${gatewayMethod.toUpperCase()})` : "Razorpay Checkout",
  };
}

function normaliseUploadedPdfBuffer(buffer, fallbackFileName, declaredSize = 0) {
  const fileName = sanitizeFileName(fallbackFileName);

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    const error = new Error("The original PDF must be included before continuing.");
    error.statusCode = 400;
    throw error;
  }

  if (!isPdfBuffer(buffer)) {
    const error = new Error("The uploaded file is not a valid PDF.");
    error.statusCode = 400;
    throw error;
  }

  if (buffer.length > MAX_FORWARDABLE_PDF_MB * 1024 * 1024) {
    const error = new Error(
      `The uploaded PDF is too large to forward by email. Keep it below ${MAX_FORWARDABLE_PDF_MB} MB.`
    );
    error.statusCode = 400;
    throw error;
  }

  return {
    fileName,
    contentType: "application/pdf",
    size: declaredSize > 0 ? Math.min(declaredSize, buffer.length) : buffer.length,
    buffer,
  };
}

function normaliseUploadedPdf(upload, fallbackFileName) {
  const payload = upload && typeof upload === "object" ? upload : {};
  const base64 = sanitizeText(payload.base64);

  if (!base64) {
    const error = new Error("The original PDF must be included before confirming payment.");
    error.statusCode = 400;
    throw error;
  }

  return normaliseUploadedPdfBuffer(
    Buffer.from(base64, "base64"),
    payload.fileName || fallbackFileName,
    Number(payload.size || 0)
  );
}

async function analyzeUploadedPdf(uploadedPdf) {
  await fs.promises.mkdir(TEMP_UPLOAD_DIR, { recursive: true });
  const tempPdfPath = path.join(
    TEMP_UPLOAD_DIR,
    `${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`
  );

  await fs.promises.writeFile(tempPdfPath, uploadedPdf.buffer);

  try {
    const parsed = await runPdfTool(["analyze", tempPdfPath], PDF_ANALYSIS_TIMEOUT_MS, "PDF analysis");

    if (
      !Number.isFinite(Number(parsed.totalPages)) ||
      !Number.isFinite(Number(parsed.bwPages)) ||
      !Number.isFinite(Number(parsed.colorPages))
    ) {
      throw new Error("PDF analysis returned an invalid result.");
    }

    return {
      totalPages: Number(parsed.totalPages),
      bwPages: Number(parsed.bwPages),
      colorPages: Number(parsed.colorPages),
    };
  } catch (error) {
    const details = [
      error.stderr ? String(error.stderr).trim() : "",
      error.stdout ? String(error.stdout).trim() : "",
      error.message,
    ].find(Boolean);
    const wrappedError = new Error(details || "PDF analysis failed.");
    wrappedError.statusCode = 500;
    throw wrappedError;
  } finally {
    await fs.promises.unlink(tempPdfPath).catch(() => {});
  }
}

function buildProcessedPdfFileName(fileName) {
  const baseName = String(fileName || "document").replace(/\.pdf$/i, "");
  return `${baseName}-bw.pdf`;
}

async function convertUploadedPdfToBlackWhite(uploadedPdf) {
  await fs.promises.mkdir(TEMP_UPLOAD_DIR, { recursive: true });
  const tempInputPath = path.join(
    TEMP_UPLOAD_DIR,
    `${Date.now()}-${Math.random().toString(36).slice(2)}-source.pdf`
  );
  const tempOutputPath = path.join(
    TEMP_UPLOAD_DIR,
    `${Date.now()}-${Math.random().toString(36).slice(2)}-bw.pdf`
  );

  await fs.promises.writeFile(tempInputPath, uploadedPdf.buffer);

  try {
    await runPdfTool(
      ["convert-bw", tempInputPath, tempOutputPath, String(MAX_FORWARDABLE_PDF_MB * 1024 * 1024)],
      PDF_CONVERSION_TIMEOUT_MS,
      "B/W PDF conversion"
    );

    const convertedBuffer = await fs.promises.readFile(tempOutputPath);
    return normaliseUploadedPdfBuffer(
      convertedBuffer,
      buildProcessedPdfFileName(uploadedPdf.fileName),
      convertedBuffer.length
    );
  } catch (error) {
    const wrappedError = new Error(
      error.message || "Black-and-white PDF conversion failed."
    );
    wrappedError.statusCode = error.statusCode || 500;
    throw wrappedError;
  } finally {
    await fs.promises.unlink(tempInputPath).catch(() => {});
    await fs.promises.unlink(tempOutputPath).catch(() => {});
  }
}

async function runPdfTool(args, timeoutMs, taskLabel) {
  try {
    const { stdout, stderr } = await execFileAsync(
      PYTHON_EXECUTABLE,
      [...PYTHON_EXECUTABLE_ARGS, PDF_ANALYSIS_SCRIPT, ...args],
      {
        cwd: ROOT,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 20,
      }
    );

    const trimmedStdout = String(stdout || "").trim();
    const trimmedStderr = String(stderr || "").trim();

    if (trimmedStderr) {
      console.warn(`${taskLabel} stderr:`, trimmedStderr);
    }

    const parsed = JSON.parse(trimmedStdout || "{}");
    if (parsed.error) {
      throw new Error(parsed.error);
    }

    return parsed;
  } catch (error) {
    const details = [
      error.stderr ? String(error.stderr).trim() : "",
      error.stdout ? String(error.stdout).trim() : "",
      error.message,
    ].find(Boolean);
    const wrappedError = new Error(details || `${taskLabel} failed.`);
    wrappedError.statusCode = 500;
    throw wrappedError;
  }
}

async function assertUniqueTransactionId(order) {
  if (order.payment.method !== "upi") {
    return;
  }

  const orders = await loadStoredOrders();
  const duplicate = orders.find(
    (entry) =>
      sanitizeTransactionId(entry?.payment?.transactionId) === order.payment.transactionId &&
      sanitizeText(entry?.orderId) !== order.orderId
  );

  if (duplicate) {
    const error = new Error(
      `This UPI transaction ID was already used for order ${duplicate.orderId}. Enter the exact new transaction ID from the payment app.`
    );
    error.statusCode = 409;
    throw error;
  }
}

function buildVerificationChecks(order) {
  const checks = [
    "PDF page totals matched the black and white plus color page counts.",
    `Amount matched automatic pricing: ${formatCurrency(order.document.pricePerCopy)} per copy x ${order.document.copies} copies = ${formatCurrency(order.amount)}.`,
  ];

  if (order.document.printMode === "bw-only") {
    checks.push("Customer selected Black & White only mode for the print-ready PDF.");
    if (order.document.convertedToBw) {
      checks.push("Color pages were converted to black and white before forwarding to the print desk.");
    }
  }

  if (order.payment.method === "upi") {
    checks.push(`Exact UPI transaction ID captured: ${order.payment.transactionId}.`);
    checks.push(`Payer UPI ID captured: ${order.payment.payerUpiId}.`);
    if (order.payment.attemptId) {
      checks.push(`Customer payment attempt tracked under ID ${order.payment.attemptId}.`);
    }
    checks.push("Duplicate transaction ID check passed against previously saved orders.");
  } else if (order.payment.method === "razorpay") {
    checks.push(`Razorpay payment ID verified: ${order.payment.razorpayPaymentId || order.payment.transactionId}.`);
    checks.push(`Razorpay order ID verified: ${order.payment.razorpayOrderId}.`);
    checks.push("Razorpay payment signature matched the server secret.");
    if (order.payment.gatewayMethod) {
      checks.push(`Razorpay reported payment method: ${order.payment.gatewayMethod}.`);
    }
    if (order.payment.payerUpiId) {
      checks.push(`Razorpay reported payer UPI ID: ${order.payment.payerUpiId}.`);
    }
    checks.push("Razorpay payment status was confirmed as captured.");
  } else {
    checks.push("Cash on pickup was selected instead of online payment.");
  }

  return checks;
}

function getPaymentDetailRows(order, statusText) {
  if (order.payment.method === "razorpay") {
    return [
      { label: "Payment Provider", value: "Razorpay" },
      { label: "Razorpay Payment ID", value: order.payment.razorpayPaymentId || order.payment.transactionId || "NA" },
      { label: "Razorpay Order ID", value: order.payment.razorpayOrderId || "NA" },
      { label: "Payment Method", value: order.payment.gatewayMethod || "Online Payment" },
      { label: "Payment Status", value: statusText },
      { label: "Date & Time", value: formatDateTime(order.payment.paidAt), valueFont: "Helvetica" },
    ];
  }

  if (order.payment.method === "upi") {
    return [
      { label: "UPI ID", value: order.payment.payerUpiId || "NA" },
      { label: "Transaction ID", value: order.payment.transactionId || "NA" },
      { label: "Payment Status", value: statusText },
      { label: "Date & Time", value: formatDateTime(order.payment.paidAt), valueFont: "Helvetica" },
    ];
  }

  return [
    { label: "Payment Mode", value: "Cash on Pickup" },
    { label: "Payment Status", value: statusText },
    { label: "Date & Time", value: formatDateTime(order.payment.paidAt), valueFont: "Helvetica" },
  ];
}

function renderPaymentDetailHtmlLines(order) {
  return getPaymentDetailRows(order, getPaymentStatusLabel(order))
    .map((item) => `<p style="margin:0 0 8px;"><strong>${escapeHtml(item.label)}:</strong> ${escapeHtml(item.value)}</p>`)
    .join("");
}

function generateInvoicePdf(order, verificationChecks) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 0,
      info: {
        Title: `${BUSINESS_NAME} - ${order.orderId}`,
        Author: BUSINESS_NAME,
      },
    });

    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const gutter = 24;
    const contentX = 42;
    const contentWidth = pageWidth - contentX * 2;
    const halfWidth = (contentWidth - gutter) / 2;
    const metricWidth = (contentWidth - gutter * 2) / 3;
    const statusText = getPaymentStatusLabel(order);
    const generatedAt = formatDateTime(new Date().toISOString());

    function drawCard(x, y, width, height, options = {}) {
      const fill = options.fill || "#ffffff";
      const stroke = options.stroke || "#dbe7ff";
      doc.save();
      doc.roundedRect(x, y, width, height, options.radius || 18).fillAndStroke(fill, stroke);
      doc.restore();
    }

    function drawLabelValue(x, y, width, label, value, options = {}) {
      const labelColor = options.labelColor || "#6b7280";
      const valueColor = options.valueColor || "#0f172a";
      const labelSize = options.labelSize || 9;
      const valueSize = options.valueSize || 12;

      doc.fillColor(labelColor).font("Helvetica").fontSize(labelSize).text(label, x, y, { width });
      const labelBottom = doc.y;
      doc.fillColor(valueColor).font(options.valueFont || "Helvetica-Bold").fontSize(valueSize).text(value, x, labelBottom + 4, { width });
      return doc.y;
    }

    function drawMetricCard(x, y, width, title, value) {
      drawCard(x, y, width, 74, { fill: "#f8fbff" });
      doc.fillColor("#64748b").font("Helvetica").fontSize(9).text(title, x + 16, y + 16, { width: width - 32 });
      doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(18).text(value, x + 16, y + 34, { width: width - 32 });
    }

    function drawInfoCard(x, y, width, height, title, rows) {
      drawCard(x, y, width, height);
      doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(13).text(title, x + 18, y + 18);
      let rowY = y + 46;
      rows.forEach((row, index) => {
        rowY = drawLabelValue(x + 18, rowY, width - 36, row.label, row.value, {
          valueSize: row.valueSize || 11.5,
          valueFont: row.valueFont || "Helvetica-Bold",
        }) + 10;
        if (index < rows.length - 1) {
          doc.save();
          doc.moveTo(x + 18, rowY).lineTo(x + width - 18, rowY).lineWidth(1).strokeColor("#e8eefb").stroke();
          doc.restore();
          rowY += 10;
        }
      });
    }

    function drawTableRow(x, y, width, left, right, options = {}) {
      const rowHeight = options.height || 22;
      if (options.fill) {
        doc.save();
        doc.roundedRect(x, y - 4, width, rowHeight + 8, 10).fill(options.fill);
        doc.restore();
      }
      doc.fillColor(options.leftColor || "#334155").font(options.leftFont || "Helvetica").fontSize(options.fontSize || 11).text(left, x + 16, y, {
        width: width * 0.68 - 16,
      });
      doc.fillColor(options.rightColor || "#0f172a").font(options.rightFont || "Helvetica-Bold").fontSize(options.fontSize || 11).text(right, x, y, {
        width: width - 16,
        align: "right",
      });
      return y + rowHeight;
    }

    doc.rect(0, 0, pageWidth, pageHeight).fill("#f4f7fb");
    doc.rect(0, 0, pageWidth, 160).fill("#10213d");

    doc.fillColor("#8fd8ff").font("Helvetica-Bold").fontSize(11).text("PAYMENT SLIP / INVOICE", contentX, 34);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(28).text(BUSINESS_NAME, contentX, 50, { width: 290 });
    doc.fillColor("#d9e7ff").font("Helvetica").fontSize(11).text("Professional print order receipt with verified payment details", contentX, 85, {
      width: 310,
    });

    drawCard(pageWidth - 230, 30, 188, 102, { fill: "#ffffff", stroke: "#bfdbfe", radius: 20 });
    drawLabelValue(pageWidth - 212, 48, 152, "Order ID", order.orderId, { valueSize: 13 });
    drawLabelValue(pageWidth - 212, 88, 152, "Total Price", formatCurrency(order.amount), {
      valueSize: 18,
      valueFont: "Helvetica-Bold",
      valueColor: "#1958ff",
    });

    drawCard(contentX, 126, contentWidth, 66, { fill: "#fef3c7", stroke: "#f7d88b", radius: 18 });
    doc.fillColor("#8a5300").font("Helvetica-Bold").fontSize(10).text("PAYMENT STATUS", contentX + 20, 144);
    doc.fillColor("#10213d").font("Helvetica-Bold").fontSize(18).text(statusText, contentX + 20, 160);
    doc.fillColor("#5b6478").font("Helvetica").fontSize(11).text(
      `Paid on ${formatDateTime(order.payment.paidAt)} via ${getPaymentMethodLabel(order)}${order.payment.app ? ` | ${order.payment.app}` : ""}`,
      contentX + 220,
      160,
      { width: contentWidth - 240, align: "right" }
    );

    const customerRows = [
      { label: "Customer Name", value: order.customer.name },
      { label: "Email ID", value: order.customer.email },
      { label: "Phone", value: order.customer.phone },
      { label: "Document", value: order.document.fileName, valueFont: "Helvetica" },
    ];

    const paymentRows = getPaymentDetailRows(order, statusText);

    drawInfoCard(contentX, 216, halfWidth, 220, "Customer Details", customerRows);
    drawInfoCard(contentX + halfWidth + gutter, 216, halfWidth, 220, "Payment Details", paymentRows);

    const metricsY = 458;
    drawMetricCard(contentX, metricsY, metricWidth, "Number of Copies", String(order.document.copies));
    drawMetricCard(contentX + metricWidth + gutter, metricsY, metricWidth, "Black & White Pages", String(order.document.bwPages));
    drawMetricCard(contentX + (metricWidth + gutter) * 2, metricsY, metricWidth, "Color Pages", String(order.document.colorPages));

    drawCard(contentX, 552, halfWidth, 150);
    doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(13).text("Print Summary", contentX + 18, 570);
    let summaryY = 602;
    summaryY = drawTableRow(contentX + 2, summaryY, halfWidth - 4, "Paper Size", order.document.paperSize.toUpperCase());
    summaryY = drawTableRow(contentX + 2, summaryY + 2, halfWidth - 4, "Total Pages", String(order.document.totalPages));
    summaryY = drawTableRow(contentX + 2, summaryY + 2, halfWidth - 4, "Print Mode", getPrintModeLabel(order));
    summaryY = drawTableRow(contentX + 2, summaryY + 2, halfWidth - 4, "Price Per Copy", formatCurrency(order.document.pricePerCopy));

    drawCard(contentX + halfWidth + gutter, 552, halfWidth, 150);
    doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(13).text("Price Breakdown", contentX + halfWidth + gutter + 18, 570);
    let pricingY = 602;
    pricingY = drawTableRow(
      contentX + halfWidth + gutter + 2,
      pricingY,
      halfWidth - 4,
      `${order.document.bwPages} B/W pages x ${formatCurrency(PRICE_BW)}`,
      formatCurrency(order.document.bwCostPerCopy)
    );
    pricingY = drawTableRow(
      contentX + halfWidth + gutter + 2,
      pricingY + 2,
      halfWidth - 4,
      `${order.document.colorPages} color pages x ${formatCurrency(PRICE_COLOR)}`,
      formatCurrency(order.document.colorCostPerCopy)
    );
    drawTableRow(
      contentX + halfWidth + gutter + 2,
      pricingY + 8,
      halfWidth - 4,
      "Grand Total",
      formatCurrency(order.amount),
      {
        fill: "#e8f1ff",
        leftColor: "#103fbb",
        rightColor: "#103fbb",
        leftFont: "Helvetica-Bold",
        rightFont: "Helvetica-Bold",
        height: 26,
      }
    );

    if (order.document.notes) {
      const notesY = 724;
      const notesHeight = 46 + doc.heightOfString(order.document.notes, {
        width: contentWidth - 36,
        align: "left",
      });
      drawCard(contentX, notesY, contentWidth, notesHeight);
      doc.fillColor("#0f172a").font("Helvetica-Bold").fontSize(12).text("Special Instructions", contentX + 18, notesY + 18);
      doc.fillColor("#475569").font("Helvetica").fontSize(10.5).text(order.document.notes, contentX + 18, notesY + 40, {
        width: contentWidth - 36,
      });
    }

    doc.fillColor("#64748b").font("Helvetica").fontSize(9.2).text(
      `Generated on ${generatedAt} | ${BUSINESS_EMAIL} | ${BUSINESS_PHONE}`,
      contentX,
      pageHeight - 28,
      { width: contentWidth, align: "center" }
    );

    doc.end();
  });
}

function buildCustomerEmail(order, verificationChecks) {
  return `
    <div style="font-family:Arial,sans-serif; background:#f4f7fb; color:#10213d; padding:24px;">
      <div style="max-width:700px; margin:0 auto; background:#ffffff; border-radius:24px; overflow:hidden; border:1px solid #dbe7ff;">
        <div style="padding:32px; background:#10213d; color:#ffffff;">
          <div style="font-size:11px; letter-spacing:0.12em; text-transform:uppercase; color:#8fd8ff; font-weight:700;">Payment Receipt</div>
          <h1 style="margin:10px 0 0; font-size:30px; line-height:1.1;">${escapeHtml(getPaymentStatusLabel(order))}</h1>
          <p style="margin:12px 0 0; color:#d9e7ff;">Your print order has been confirmed with ${escapeHtml(BUSINESS_NAME)}. The invoice PDF is attached for your records.</p>
        </div>
        <div style="padding:28px 32px 32px;">
          <p>Hi ${escapeHtml(order.customer.name)},</p>
          <p style="margin-bottom:18px;">Your payment receipt is ready and your document is now in our print queue.</p>
          <div style="background:#f8fbff; border:1px solid #dbe7ff; border-radius:18px; padding:20px; margin-bottom:18px;">
            <p style="margin:0 0 8px;"><strong>Order ID:</strong> ${escapeHtml(order.orderId)}</p>
            <p style="margin:0 0 8px;"><strong>Total Price:</strong> ${escapeHtml(formatCurrency(order.amount))}</p>
            <p style="margin:0 0 8px;"><strong>Copies:</strong> ${escapeHtml(String(order.document.copies))}</p>
            <p style="margin:0 0 8px;"><strong>Black & White Pages:</strong> ${escapeHtml(String(order.document.bwPages))}</p>
            <p style="margin:0 0 8px;"><strong>Color Pages:</strong> ${escapeHtml(String(order.document.colorPages))}</p>
            <p style="margin:0 0 8px;"><strong>Print Mode:</strong> ${escapeHtml(getPrintModeLabel(order))}</p>
            ${renderPaymentDetailHtmlLines(order)}
          </div>
          <p style="margin:0 0 10px;"><strong>Verification summary</strong></p>
          ${verificationChecks.map((item) => `<p style="margin:0 0 8px;">- ${escapeHtml(item)}</p>`).join("")}
          <p style="margin-top:18px;">If you need help, reply to this email or contact us at ${escapeHtml(BUSINESS_PHONE)}.</p>
        </div>
      </div>
    </div>
  `;
}

function buildOwnerEmail(order, uploadedPdf, verificationChecks) {
  return `
    <div style="font-family:Arial,sans-serif; color:#10213d; max-width:760px; margin:0 auto;">
      <div style="background:#10213d; color:#ffffff; border-radius:24px 24px 0 0; padding:28px 30px;">
        <div style="font-size:11px; letter-spacing:0.12em; text-transform:uppercase; color:#8fd8ff; font-weight:700;">Print Desk Alert</div>
        <h2 style="margin:10px 0 0; font-size:30px;">New order ready for printing</h2>
        <p style="margin:12px 0 0; color:#d9e7ff;">Both the payment slip and the print-ready customer PDF are attached to this email.</p>
      </div>
      <div style="background:#ffffff; border:1px solid #dbe7ff; border-top:0; border-radius:0 0 24px 24px; padding:28px 30px;">
        <div style="background:#f8fbff; border:1px solid #dbe7ff; border-radius:18px; padding:20px; margin-bottom:18px;">
          <p><strong>Order ID:</strong> ${escapeHtml(order.orderId)}</p>
          <p><strong>Customer:</strong> ${escapeHtml(order.customer.name)}</p>
          <p><strong>Email:</strong> ${escapeHtml(order.customer.email)}</p>
          <p><strong>Phone:</strong> ${escapeHtml(order.customer.phone)}</p>
          <p><strong>Print-ready PDF:</strong> ${escapeHtml(uploadedPdf.fileName)}</p>
          <p><strong>Print Mode:</strong> ${escapeHtml(getPrintModeLabel(order))}</p>
          <p><strong>Copies:</strong> ${escapeHtml(String(order.document.copies))}</p>
          <p><strong>Black & White Pages:</strong> ${escapeHtml(String(order.document.bwPages))}</p>
          <p><strong>Color Pages:</strong> ${escapeHtml(String(order.document.colorPages))}</p>
          <p><strong>Total Price:</strong> ${escapeHtml(formatCurrency(order.amount))}</p>
          <p><strong>Payment App:</strong> ${escapeHtml(order.payment.app || "NA")}</p>
          ${renderPaymentDetailHtmlLines(order)}
          <p><strong>Notes:</strong> ${escapeHtml(order.document.notes || "None")}</p>
        </div>
        <div style="background:#fff8ee; border:1px solid #fde3bf; border-radius:18px; padding:18px;">
          <p style="margin-top:0;"><strong>Verification checks</strong></p>
        ${verificationChecks.map((item) => `<p style="margin:0 0 8px;">- ${escapeHtml(item)}</p>`).join("")}
        </div>
        <p style="margin-top:18px;">Attachments included: payment slip PDF and original customer PDF for direct printing.</p>
      </div>
    </div>
  `;
}

async function sendOrderEmails(order, invoiceBuffer, uploadedPdf, verificationChecks) {
  if (DRY_RUN_NOTIFICATIONS) {
    return {
      customer: order.customer.email,
      owner: ORDER_NOTIFICATION_EMAIL,
      originalPdfForwardedToOwner: true,
      originalPdfFileName: uploadedPdf.fileName,
      dryRun: true,
    };
  }

  const invoiceAttachment = {
    filename: `${order.orderId}.pdf`,
    content: invoiceBuffer,
    contentType: "application/pdf",
  };
  const ownerPdfAttachment = {
    filename: uploadedPdf.fileName,
    content: uploadedPdf.buffer,
    contentType: uploadedPdf.contentType,
  };

  if (MAIL_PROVIDER === "mailjet") {
    await Promise.all([
      sendMailjetEmail({
        to: { email: order.customer.email, name: order.customer.name },
        subject: `${getPaymentStatusLabel(order)} - Rahul Prints Order ${order.orderId}`,
        html: buildCustomerEmail(order, verificationChecks),
        attachments: [invoiceAttachment],
      }),
      sendMailjetEmail({
        to: { email: ORDER_NOTIFICATION_EMAIL, name: BUSINESS_NAME },
        subject: `${order.payment.method === "cod" ? "New pickup order" : "New paid order"} - ${order.orderId}`,
        html: buildOwnerEmail(order, uploadedPdf, verificationChecks),
        attachments: [invoiceAttachment, ownerPdfAttachment],
      }),
    ]);
  } else {
    if (!transporter) {
      const error = new Error(
        "Email delivery is not configured. Set MAIL_PROVIDER=mailjet with Mailjet API keys or configure SMTP credentials."
      );
      error.statusCode = 500;
      throw error;
    }

    await Promise.all([
      transporter.sendMail({
        from: `${MAIL_FROM_NAME} <${MAIL_FROM_EMAIL}>`,
        to: order.customer.email,
        subject: `${getPaymentStatusLabel(order)} - Rahul Prints Order ${order.orderId}`,
        html: buildCustomerEmail(order, verificationChecks),
        attachments: [invoiceAttachment],
      }),
      transporter.sendMail({
        from: `${MAIL_FROM_NAME} <${MAIL_FROM_EMAIL}>`,
        to: ORDER_NOTIFICATION_EMAIL,
        subject: `${order.payment.method === "cod" ? "New pickup order" : "New paid order"} - ${order.orderId}`,
        html: buildOwnerEmail(order, uploadedPdf, verificationChecks),
        attachments: [invoiceAttachment, ownerPdfAttachment],
      }),
    ]);
  }

  return {
    customer: order.customer.email,
    owner: ORDER_NOTIFICATION_EMAIL,
    originalPdfForwardedToOwner: true,
    originalPdfFileName: uploadedPdf.fileName,
  };
}

async function persistOrderArtifacts(order, uploadedPdf, invoiceBuffer) {
  const orderDir = path.join(ORDER_ARTIFACTS_DIR, sanitizeOrderDirectoryName(order.orderId));

  await fs.promises.mkdir(orderDir, { recursive: true });
  await fs.promises.writeFile(path.join(orderDir, "customer-upload.pdf"), uploadedPdf.buffer);
  await fs.promises.writeFile(path.join(orderDir, "invoice.pdf"), invoiceBuffer);
  await fs.promises.writeFile(
    path.join(orderDir, "summary.json"),
    JSON.stringify(
      {
        orderId: order.orderId,
        savedAt: new Date().toISOString(),
        uploadedPdfFileName: uploadedPdf.fileName,
        invoiceFileName: `${order.orderId}.pdf`,
      },
      null,
      2
    ),
    "utf8"
  );

  return {
    storedLocally: true,
    orderDirectory: path.relative(ROOT, orderDir),
    uploadedPdfPath: path.relative(ROOT, path.join(orderDir, "customer-upload.pdf")),
    invoicePath: path.relative(ROOT, path.join(orderDir, "invoice.pdf")),
  };
}

async function deliverOrderNotifications(order, invoiceBuffer, uploadedPdf, verificationChecks) {
  try {
    const emails = await sendOrderEmails(order, invoiceBuffer, uploadedPdf, verificationChecks);
    return {
      emails,
      warnings: [],
      notificationError: "",
    };
  } catch (error) {
    console.warn(`Order ${order.orderId} email delivery failed:`, error.message);
    return {
      emails: {
        customer: order.customer.email,
        owner: ORDER_NOTIFICATION_EMAIL,
        originalPdfForwardedToOwner: false,
        originalPdfFileName: uploadedPdf.fileName,
        deliveryFailed: true,
      },
      warnings: [
        "Automatic email delivery is pending. The payment receipt is ready, and Rahul Prints can recover this order from the server for manual follow-up.",
      ],
      notificationError: error.message || "Email delivery failed.",
    };
  }
}

async function saveConfirmedOrder(order, uploadedPdf, verificationChecks, outcome) {
  const record = {
    ...order,
    uploadedPdf: {
      fileName: uploadedPdf.fileName,
      contentType: uploadedPdf.contentType,
      size: uploadedPdf.size,
    },
    savedAt: new Date().toISOString(),
    verificationChecks,
    notifications: {
      emails: outcome.emails,
      warnings: outcome.warnings || [],
      error: outcome.notificationError || "",
    },
  };

  if (outcome.artifacts) {
    record.artifacts = outcome.artifacts;
  }

  await saveStoredOrder(record);
}

async function handleOrderConfirmation(response, payload) {
  try {
    const order = normaliseOrder(payload);
    if (order.payment.method === "upi" && order.payment.attemptId) {
      await updatePaymentAttemptStatus(order.payment.attemptId, "confirmation-submitted", {
        appLabel: order.payment.app,
        transactionId: order.payment.transactionId,
        payerUpiId: order.payment.payerUpiId,
      }).catch((error) => {
        console.warn(`Payment attempt ${order.payment.attemptId} update failed before confirmation:`, error.message);
      });
    }
    let uploadedPdf = normaliseUploadedPdf(payload?.upload, order.document.fileName);
    if (order.document.printMode === "bw-only" && order.document.convertedToBw) {
      uploadedPdf = await convertUploadedPdfToBlackWhite(uploadedPdf);
    }
    if (order.payment.method === "razorpay") {
      const verifiedPayment = await verifyRazorpayPayment(order);
      order.payment.transactionId = verifiedPayment.paymentId;
      order.payment.razorpayPaymentId = verifiedPayment.paymentId;
      order.payment.razorpayOrderId = verifiedPayment.orderId;
      order.payment.payerUpiId = verifiedPayment.vpa || order.payment.payerUpiId;
      order.payment.paidAt = verifiedPayment.paidAt;
      order.payment.app = verifiedPayment.appLabel;
      order.payment.gatewayProvider = "Razorpay";
      order.payment.gatewayMethod = verifiedPayment.method;
      order.payment.gatewayStatus = verifiedPayment.status;
      order.payment.gatewayEmail = verifiedPayment.email;
      order.payment.gatewayContact = verifiedPayment.contact;
      order.payment.verificationStatus = "gateway-verified";
    }
    await assertUniqueTransactionId(order);

    const verificationChecks = buildVerificationChecks(order);
    const invoiceBuffer = await generateInvoicePdf(order, verificationChecks);
    let artifacts = null;
    try {
      artifacts = await persistOrderArtifacts(order, uploadedPdf, invoiceBuffer);
    } catch (error) {
      console.warn(`Order ${order.orderId} local artifact persistence failed:`, error.message);
    }

    const notificationOutcome = await deliverOrderNotifications(order, invoiceBuffer, uploadedPdf, verificationChecks);

    if (!artifacts && notificationOutcome.notificationError) {
      const fatalError = new Error(
        "The order could not be secured after payment. Please contact Rahul Prints immediately before retrying."
      );
      fatalError.statusCode = 500;
      throw fatalError;
    }

    const outcome = {
      ...notificationOutcome,
      artifacts,
    };

    try {
      await saveConfirmedOrder(order, uploadedPdf, verificationChecks, outcome);
    } catch (error) {
      console.warn(`Order ${order.orderId} store write failed:`, error.message);
      outcome.warnings = [
        ...(outcome.warnings || []),
        "Order history storage is pending, but the payment receipt is already ready for download.",
      ];
    }

    if (order.payment.method === "upi" && order.payment.attemptId) {
      await updatePaymentAttemptStatus(order.payment.attemptId, "confirmed", {
        appLabel: order.payment.app,
        transactionId: order.payment.transactionId,
        payerUpiId: order.payment.payerUpiId,
        confirmationMessage: "Payment confirmed and receipt generated.",
      }).catch((error) => {
        console.warn(`Payment attempt ${order.payment.attemptId} final update failed:`, error.message);
      });
    }

    sendJson(response, 200, {
      success: true,
      orderId: order.orderId,
      amount: order.amount,
      invoiceFileName: `${order.orderId}.pdf`,
      invoiceBase64: invoiceBuffer.toString("base64"),
      emails: outcome.emails,
      warnings: outcome.warnings || [],
      verification: {
        transactionId: order.payment.transactionId,
        payerUpiId: order.payment.payerUpiId,
        gatewayOrderId: order.payment.razorpayOrderId,
        gatewayPaymentId: order.payment.razorpayPaymentId,
        gatewayMethod: order.payment.gatewayMethod,
        checks: verificationChecks,
      },
      attachments: {
        invoicePdf: `${order.orderId}.pdf`,
        originalPdfFileName: uploadedPdf.fileName,
        originalPdfForwardedToOwner: Boolean(outcome.emails?.originalPdfForwardedToOwner),
        originalPdfStoredOnServer: Boolean(artifacts?.storedLocally),
      },
      receipt: {
        businessName: BUSINESS_NAME,
        orderId: order.orderId,
        customerName: order.customer.name,
        customerEmail: order.customer.email,
        merchantUpiId: order.payment.method === "upi" ? UPI_ID : "",
        paymentAttemptId: order.payment.attemptId,
        payerUpiId: order.payment.payerUpiId,
        transactionId: order.payment.transactionId,
        gatewayProvider: order.payment.gatewayProvider || (order.payment.method === "razorpay" ? "Razorpay" : ""),
        gatewayMethod: order.payment.gatewayMethod || "",
        gatewayOrderId: order.payment.razorpayOrderId || "",
        gatewayPaymentId: order.payment.razorpayPaymentId || "",
        copies: order.document.copies,
        colorPages: order.document.colorPages,
        bwPages: order.document.bwPages,
        totalPrice: order.amount,
        paymentStatus: getPaymentStatusLabel(order),
        paymentMethod: getPaymentMethodLabel(order),
        printMode: order.document.printMode,
        printModeLabel: getPrintModeLabel(order),
        paidAt: order.payment.paidAt,
        documentName: order.document.fileName,
        ownerEmail: ORDER_NOTIFICATION_EMAIL,
      },
      message: notificationOutcome.notificationError
        ? "Payment recorded and invoice generated. Automatic email delivery is pending."
        : "Payment completed and invoice generated.",
    });
  } catch (error) {
    const attemptId = sanitizeText(payload?.payment?.attemptId);
    if (attemptId) {
      await updatePaymentAttemptStatus(attemptId, "confirmation-error", {
        appLabel: sanitizeText(payload?.payment?.app),
        transactionId: sanitizeTransactionId(payload?.payment?.transactionId),
        payerUpiId: sanitizeUpiId(payload?.payment?.payerUpiId),
        confirmationMessage: error.message || "Payment confirmation failed.",
      }).catch((attemptError) => {
        console.warn(`Payment attempt ${attemptId} error update failed:`, attemptError.message);
      });
    }
    sendJson(response, error.statusCode || 500, {
      success: false,
      error: error.message || "Something went wrong while confirming the order.",
    });
  }
}

async function handlePdfAnalysis(response, request) {
  try {
    const bodyBuffer = await readRequestBuffer(request);
    const fileName = decodeHeaderValue(request.headers["x-file-name"], "document.pdf");
    const declaredSize = Number(request.headers["x-file-size"] || 0);
    const uploadedPdf = normaliseUploadedPdfBuffer(bodyBuffer, fileName, declaredSize);
    const analysis = await analyzeUploadedPdf(uploadedPdf);

    sendJson(response, 200, {
      success: true,
      analysis,
      fileName: uploadedPdf.fileName,
    });
  } catch (error) {
    sendJson(response, error.statusCode || 400, {
      success: false,
      error: error.message || "Could not analyze the PDF.",
    });
  }
}

function buildPublicConfig() {
  return {
    businessName: BUSINESS_NAME,
    businessEmail: BUSINESS_EMAIL,
    businessPhone: BUSINESS_PHONE,
    razorpayKeyId: RAZORPAY_KEY_ID,
    razorpayEnabled: isRazorpayConfigured(),
    upiId: UPI_ID,
    upiPayeeName: UPI_PAYEE_NAME,
    upiMerchantCode: UPI_MERCHANT_CODE,
    maxForwardablePdfMb: MAX_FORWARDABLE_PDF_MB,
    pricing: {
      bw: PRICE_BW,
      color: PRICE_COLOR,
    },
    paymentTimeoutMinutes: PAYMENT_TIMEOUT_MINUTES,
    bwModeAvailable: true,
  };
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const { pathname } = requestUrl;

  if (request.method === "GET" && pathname === "/config.js") {
    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[".js"],
      "Cache-Control": "no-store",
    });
    response.end(`window.APP_CONFIG = ${JSON.stringify(buildPublicConfig())};`);
    return;
  }

  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, {
      success: true,
      status: "ok",
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/pdf/analyze") {
    await handlePdfAnalysis(response, request);
    return;
  }

  if (request.method === "POST" && pathname === "/api/payments/razorpay/order") {
    try {
      const payload = await readJsonBody(request);
      await handleRazorpayOrderRequest(response, payload);
    } catch (error) {
      sendJson(response, error.statusCode || 400, {
        success: false,
        error: error.message || "Could not start Razorpay checkout.",
      });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/payment-attempts/start") {
    try {
      const payload = await readJsonBody(request);
      await handlePaymentAttemptStart(response, payload);
    } catch (error) {
      sendJson(response, error.statusCode || 400, {
        success: false,
        error: error.message || "Could not start the payment attempt.",
      });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/payment-attempts/update") {
    try {
      const payload = await readJsonBody(request);
      await handlePaymentAttemptUpdate(response, payload);
    } catch (error) {
      sendJson(response, error.statusCode || 400, {
        success: false,
        error: error.message || "Could not update the payment attempt.",
      });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/orders/confirm") {
    try {
      const payload = await readJsonBody(request);
      await handleOrderConfirmation(response, payload);
    } catch (error) {
      sendJson(response, 400, {
        success: false,
        error: error.message || "Unable to process request.",
      });
    }
    return;
  }

  if (request.method === "GET" && pathname === "/api/upi/qr") {
    await handleUpiQrRequest(response, requestUrl);
    return;
  }

  if (request.method === "GET" && Object.prototype.hasOwnProperty.call(STATIC_FILES, pathname)) {
    serveFile(response, pathname);
    return;
  }

  sendJson(response, 404, { success: false, error: "Not found." });
});

function startServer(preferredPort, attempt = 0) {
  const currentPort = Number(preferredPort) + attempt;

  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attempt < MAX_PORT_FALLBACK_ATTEMPTS) {
      const nextPort = currentPort + 1;
      console.warn(`Port ${currentPort} on ${HOST} is already in use. Trying http://${HOST}:${nextPort} instead...`);
      startServer(preferredPort, attempt + 1);
      return;
    }

    console.error(`Could not start Rahul Prints on ${HOST}:${currentPort}.`);
    throw error;
  });

  server.listen(currentPort, HOST, () => {
    console.log(`Rahul Prints server is running on http://${HOST}:${currentPort}`);
  });
}

startServer(PORT);
