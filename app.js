const APP_CONFIG = window.APP_CONFIG || {
  businessName: "Rahul Prints",
  businessEmail: "owner@example.com",
  businessPhone: "+919345574203",
  upiId: "rahulsiva190@okicici",
  upiMerchantCode: "",
  maxForwardablePdfMb: 18,
  pricing: { bw: 1, color: 10 },
  paymentTimeoutMinutes: 5,
};

const state = {
  pdfAnalysis: null,
  currentOrder: null,
  paymentMethod: "upi",
  paymentExpiresAt: null,
  timerIntervalId: null,
  timerExpired: false,
  invoiceBlob: null,
  invoiceFileName: "",
  lastSuccessResponse: null,
  forceBlackWhite: false,
  processedBwUpload: null,
  processedBwPromise: null,
  isAnalyzingPdf: false,
  analysisProgress: null,
  analysisRunId: 0,
  upiFallbackTimerId: null,
  externalPaymentAttempt: null,
  scrollAnimationFrameId: null,
  scrollTargetTimerId: null,
};

const elements = {};
const UPI_APP_CONFIG = {
  gpay: {
    label: "Google Pay",
    androidPackage: "com.google.android.apps.nbu.paisa.user",
    iosScheme: "gpay",
    iosPath: "upi/pay",
  },
  phonepe: {
    label: "PhonePe",
    androidPackage: "com.phonepe.app",
    iosScheme: "phonepe",
    iosPath: "upi/pay",
  },
};

document.addEventListener("DOMContentLoaded", () => {
  wireElements();
  applyPublicConfig();
  configurePdfWorker();
  bindEvents();
  refreshPricingPreview();
});

function wireElements() {
  [
    "fileInput",
    "fileName",
    "bwModeToggle",
    "bwModeHint",
    "bwModeStatus",
    "bwSavingsBanner",
    "bwSavingsTitle",
    "bwSavingsText",
    "costDisplay",
    "analysisBadgeText",
    "bwCount",
    "colorCount",
    "totalPages",
    "copiesPreview",
    "costPerCopy",
    "totalPrice",
    "bwPricingLine",
    "colorPricingLine",
    "grandTotalLine",
    "uploadForm",
    "copies",
    "copiesDecreaseButton",
    "copiesIncreaseButton",
    "paperSize",
    "name",
    "phone",
    "email",
    "notes",
    "paymentSection",
    "paymentDetails",
    "paymentAmount",
    "orderIdDisplay",
    "paymentTimer",
    "timerChip",
    "qrCode",
    "upiIdText",
    "gpayLaunchButton",
    "phonePeLaunchButton",
    "upiLaunchButton",
    "copyUpiButton",
    "paymentConfirmationForm",
    "paymentFeedback",
    "paymentApp",
    "transactionId",
    "payerUpiId",
    "confirmPaymentButton",
    "confirmCodButton",
    "upiPanel",
    "codPanel",
    "paymentSuccess",
    "successTitle",
    "successLead",
    "deliveryStatus",
    "downloadInvoiceButton",
    "newOrderButton",
    "toast",
    "priceBwDisplay",
    "priceColorDisplay",
    "paymentWindowDisplay",
    "supportPhoneLink",
    "contactPhoneText",
    "contactEmailText",
  ].forEach((id) => {
    elements[id] = document.getElementById(id);
  });

  elements.methodTabs = Array.from(document.querySelectorAll(".method-tab"));
  elements.paymentProgressItems = Array.from(document.querySelectorAll("[data-payment-step]"));
  elements.quickScrollLinks = Array.from(document.querySelectorAll("[data-scroll-target]"));
}

function applyPublicConfig() {
  elements.priceBwDisplay.textContent = formatCurrency(APP_CONFIG.pricing.bw);
  elements.priceColorDisplay.textContent = formatCurrency(APP_CONFIG.pricing.color);
  elements.paymentWindowDisplay.textContent = `${APP_CONFIG.paymentTimeoutMinutes} minutes`;
  elements.upiIdText.textContent = APP_CONFIG.upiId;
  elements.supportPhoneLink.href = `tel:${normalisePhone(APP_CONFIG.businessPhone)}`;
  elements.supportPhoneLink.textContent = `Call ${APP_CONFIG.businessPhone}`;
  elements.contactPhoneText.textContent = APP_CONFIG.businessPhone;
  elements.contactEmailText.textContent = APP_CONFIG.businessEmail;
}

function configurePdfWorker() {
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }
}

function hasBlackWhiteConversionTools() {
  return APP_CONFIG.bwModeAvailable !== false;
}

function bindEvents() {
  document.addEventListener("visibilitychange", handlePaymentAppVisibilityChange);
  elements.fileInput.addEventListener("change", handleFileSelection);
  elements.bwModeToggle.addEventListener("change", handleBlackWhiteModeChange);
  elements.copies.addEventListener("input", handleCopiesChange);
  elements.copies.addEventListener("change", handleCopiesChange);
  elements.copiesDecreaseButton.addEventListener("click", () => adjustCopies(-1));
  elements.copiesIncreaseButton.addEventListener("click", () => adjustCopies(1));
  elements.uploadForm.addEventListener("submit", handleOrderReview);
  elements.paymentConfirmationForm.addEventListener("submit", confirmUpiPayment);
  elements.paymentApp.addEventListener("change", showDefaultPaymentFeedback);
  elements.transactionId.addEventListener("input", handleTransactionIdInput);
  elements.payerUpiId.addEventListener("input", handlePayerUpiIdInput);
  elements.gpayLaunchButton.addEventListener("click", () => launchNamedUpiApp("gpay"));
  elements.phonePeLaunchButton.addEventListener("click", () => launchNamedUpiApp("phonepe"));
  elements.upiLaunchButton.addEventListener("click", launchUpiApp);
  elements.copyUpiButton.addEventListener("click", copyUpiId);
  elements.confirmCodButton.addEventListener("click", confirmCodOrder);
  elements.downloadInvoiceButton.addEventListener("click", downloadInvoice);
  elements.newOrderButton.addEventListener("click", startFreshOrder);
  elements.quickScrollLinks.forEach((link) => link.addEventListener("click", handleQuickScrollLink));
  elements.methodTabs.forEach((button) =>
    button.addEventListener("click", () => setPaymentMethod(button.dataset.method))
  );
}

async function handleFileSelection(event) {
  const file = event.target.files[0];
  const analysisRunId = state.analysisRunId + 1;
  state.analysisRunId = analysisRunId;

  clearPaymentFeedback();
  clearCompletedOrderArtifacts();
  clearProcessedBwCache();
  state.pdfAnalysis = null;
  state.isAnalyzingPdf = false;
  state.analysisProgress = null;
  refreshPricingPreview();
  resetPendingPaymentSession();

  if (!file) {
    elements.fileName.textContent = "No PDF selected yet.";
    updateBlackWhiteModeUi();
    return;
  }

  if (!isPdfFile(file)) {
    event.target.value = "";
    elements.fileName.textContent = "Only PDF files are supported for automatic pricing.";
    updateBlackWhiteModeUi();
    showToast("Please upload a PDF file. Page detection and pricing rely on PDF analysis.", true);
    return;
  }

  if (file.size > getMaxForwardablePdfBytes()) {
    event.target.value = "";
    elements.fileName.textContent = `PDF must stay within ${getMaxForwardablePdfMb()} MB for automatic owner email forwarding.`;
    updateBlackWhiteModeUi();
    showToast(
      `This PDF is too large to email after payment. Please upload a PDF below ${getMaxForwardablePdfMb()} MB.`,
      true
    );
    return;
  }

  state.isAnalyzingPdf = true;
  state.analysisProgress = {
    fileName: file.name,
    processedPages: 0,
    totalPages: 0,
    bwPages: 0,
    colorPages: 0,
  };
  elements.fileName.textContent = `Opening ${file.name}...`;
  refreshPricingPreview();

  try {
    state.pdfAnalysis = await analyzePdf(file, (progress) => {
      if (state.analysisRunId !== analysisRunId) {
        return;
      }

      state.analysisProgress = {
        fileName: file.name,
        ...progress,
      };

      elements.fileName.textContent = progress.totalPages
        ? `Analyzing ${file.name} (${progress.processedPages}/${progress.totalPages} pages)...`
        : `Opening ${file.name}...`;
      refreshPricingPreview();
    });
    if (state.analysisRunId !== analysisRunId) {
      return;
    }

    state.isAnalyzingPdf = false;
    state.analysisProgress = null;
    elements.fileName.textContent = `${file.name} analyzed successfully.`;
    refreshPricingPreview();
    showToast("PDF analyzed. Review the detected black and white pages, color pages, and total price.");
  } catch (error) {
    if (state.analysisRunId !== analysisRunId) {
      return;
    }

    state.pdfAnalysis = null;
    state.isAnalyzingPdf = false;
    state.analysisProgress = null;
    refreshPricingPreview();
    elements.fileName.textContent = `${file.name} could not be analyzed.`;
    showToast(getFriendlyPdfAnalysisErrorMessage(error), true);
  }
}

function handleBlackWhiteModeChange() {
  if (elements.bwModeToggle.disabled) {
    elements.bwModeToggle.checked = state.forceBlackWhite;
    return;
  }

  state.forceBlackWhite = elements.bwModeToggle.checked;
  clearPaymentFeedback();
  clearCompletedOrderArtifacts();
  refreshPricingPreview();

  const summary = buildPricingSummary();
  const file = elements.fileInput.files[0];

  if (!summary) {
    return;
  }

  if (summary.convertedToBw && file) {
    showToast(
      `Black & White mode enabled. All pages will be converted and you save ${formatCurrency(
        summary.savingsPerCopy * summary.copies
      )} on this order.`
    );
  } else if (state.forceBlackWhite) {
    showToast("This PDF already appears to be black and white. The lower B/W pricing stays applied.");
  } else {
    showToast("Original color mix restored. The pricing and payment amount were updated automatically.");
  }

  if (state.currentOrder && isPendingPaymentSessionVisible()) {
    try {
      state.currentOrder = buildOrderFromForm({
        orderId: state.currentOrder.orderId,
        createdAt: state.currentOrder.createdAt,
      });
      renderPaymentSession({
        restartTimer: true,
        resetConfirmationFields: true,
        keepScroll: true,
      });
    } catch (error) {
      resetPendingPaymentSession();
      showToast(error.message, true);
    }
  }
}

function adjustCopies(delta) {
  const nextValue = Math.max(1, Math.min(100, getCopiesValue() + Number(delta || 0)));
  elements.copies.value = String(nextValue);
  elements.copies.dispatchEvent(new Event("input", { bubbles: true }));
}

function handleCopiesChange() {
  refreshPricingPreview();

  if (!state.pdfAnalysis || !isPendingPaymentSessionVisible()) {
    return;
  }

  try {
    state.currentOrder = buildOrderFromForm({
      orderId: state.currentOrder?.orderId,
      createdAt: state.currentOrder?.createdAt,
    });
    renderPaymentSession({
      restartTimer: true,
      resetConfirmationFields: true,
      keepScroll: true,
    });
    showToast("Copies changed. The detected pricing and UPI amount were updated automatically.");
  } catch (error) {
    resetPendingPaymentSession();
    showToast(error.message, true);
  }
}

async function analyzePdf(file, onProgress = () => {}) {
  onProgress({
    processedPages: 0,
    totalPages: 0,
    bwPages: 0,
    colorPages: 0,
  });
  try {
    const response = await fetch("/api/pdf/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        "X-File-Name": encodeURIComponent(file.name),
        "X-File-Size": String(file.size),
      },
      body: await file.arrayBuffer(),
    });
    const result = await readJsonResponse(response);

    if (!response.ok || !result.success || !result.analysis) {
      throw new Error(result.error || result.message || "Could not analyze the PDF.");
    }

    onProgress({
      processedPages: result.analysis.totalPages,
      totalPages: result.analysis.totalPages,
      bwPages: result.analysis.bwPages,
      colorPages: result.analysis.colorPages,
    });

    return result.analysis;
  } catch (error) {
    if (!window.pdfjsLib) {
      throw error;
    }

    return analyzePdfInBrowser(file, onProgress);
  }
}

async function analyzePdfInBrowser(file, onProgress = () => {}) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await window.pdfjsLib.getDocument({ data: bytes }).promise;
  let bwPages = 0;
  let colorPages = 0;

  onProgress({
    processedPages: 0,
    totalPages: pdf.numPages,
    bwPages,
    colorPages,
  });
  await yieldToBrowser();

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const isColor = await detectPageColor(page);
    page.cleanup?.();

    if (isColor) {
      colorPages += 1;
    } else {
      bwPages += 1;
    }

    if (pageNumber === 1 || pageNumber === pdf.numPages || pageNumber % 3 === 0) {
      onProgress({
        processedPages: pageNumber,
        totalPages: pdf.numPages,
        bwPages,
        colorPages,
      });
      await yieldToBrowser();
    }
  }

  return {
    totalPages: pdf.numPages,
    bwPages,
    colorPages,
  };
}

async function detectPageColor(page) {
  const viewport = page.getViewport({ scale: 0.22 });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas is not available for PDF analysis.");
  }

  canvas.width = Math.max(56, Math.floor(viewport.width));
  canvas.height = Math.max(56, Math.floor(viewport.height));

  await page.render({
    canvasContext: context,
    viewport,
  }).promise;

  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let colorPixels = 0;
  let visiblePixels = 0;
  const sampleStride = 32;
  const colorRatioThreshold = 0.04;

  for (let index = 0; index < data.length; index += sampleStride) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const a = data[index + 3];

    if (a < 120) {
      continue;
    }

    visiblePixels += 1;
    if (Math.abs(r - g) > 12 || Math.abs(g - b) > 12 || Math.abs(r - b) > 12) {
      colorPixels += 1;
      if (visiblePixels >= 140 && colorPixels / visiblePixels > colorRatioThreshold) {
        canvas.width = 0;
        canvas.height = 0;
        return true;
      }
    }
  }

  canvas.width = 0;
  canvas.height = 0;
  return visiblePixels > 0 && colorPixels / visiblePixels > colorRatioThreshold;
}

function handleOrderReview(event) {
  event.preventDefault();

  try {
    state.currentOrder = buildOrderFromForm();
    state.paymentMethod = "upi";
    renderPaymentSession({
      restartTimer: true,
      resetConfirmationFields: true,
      keepScroll: false,
    });
  } catch (error) {
    showToast(error.message, true);
  }
}

function buildOrderFromForm(existingMeta = {}) {
  const file = elements.fileInput.files[0];
  if (!file || !isPdfFile(file)) {
    throw new Error("Please upload a PDF before continuing.");
  }

  if (!state.pdfAnalysis) {
    throw new Error("Please wait for the PDF analysis to finish before continuing.");
  }

  const customerName = elements.name.value.trim();
  const customerPhone = elements.phone.value.trim();
  const customerEmail = elements.email.value.trim();
  const paperSize = elements.paperSize.value;
  const notes = elements.notes.value.trim();

  if (!customerName || !customerPhone || !customerEmail) {
    throw new Error("Please fill in customer name, phone, and email.");
  }

  const pricing = buildPricingSummary();
  if (!pricing) {
    throw new Error("The PDF analysis is missing. Please upload the PDF again.");
  }

  return {
    orderId: existingMeta.orderId || createOrderId(),
    createdAt: existingMeta.createdAt || new Date().toISOString(),
    customer: {
      name: customerName,
      phone: customerPhone,
      email: customerEmail,
    },
    document: {
      fileName: file.name,
      pagesLabel: pricing.convertedToBw
        ? `${pricing.totalPages} total (all pages converted to B/W for printing)`
        : `${pricing.totalPages} total (${pricing.bwPages} B/W + ${pricing.colorPages} Color)`,
      totalPages: pricing.totalPages,
      copies: pricing.copies,
      paperSize,
      notes,
      colorType: pricing.convertedToBw ? "bw-only" : "mixed",
      bwPages: pricing.bwPages,
      colorPages: pricing.colorPages,
      originalBwPages: pricing.originalBwPages,
      originalColorPages: pricing.originalColorPages,
      bwCostPerCopy: pricing.bwCostPerCopy,
      colorCostPerCopy: pricing.colorCostPerCopy,
      pricePerCopy: pricing.totalPerCopy,
      printMode: pricing.convertedToBw ? "bw-only" : "original",
      printModeLabel: pricing.printModeLabel,
      convertedToBw: pricing.convertedToBw,
      savingsPerCopy: pricing.savingsPerCopy,
    },
    amount: pricing.grandTotal,
  };
}

function buildPricingSummary() {
  if (!state.pdfAnalysis) {
    return null;
  }

  const copies = getCopiesValue();
  const originalBwPages = state.pdfAnalysis.bwPages;
  const originalColorPages = state.pdfAnalysis.colorPages;
  const useBlackWhiteOnly = state.forceBlackWhite && (originalColorPages < 1 || hasBlackWhiteConversionTools());
  const bwPages = useBlackWhiteOnly ? state.pdfAnalysis.totalPages : originalBwPages;
  const colorPages = useBlackWhiteOnly ? 0 : originalColorPages;
  const bwCostPerCopy = bwPages * APP_CONFIG.pricing.bw;
  const colorCostPerCopy = colorPages * APP_CONFIG.pricing.color;
  const totalPerCopy = bwCostPerCopy + colorCostPerCopy;
  const savingsPerCopy = useBlackWhiteOnly
    ? originalColorPages * Math.max(APP_CONFIG.pricing.color - APP_CONFIG.pricing.bw, 0)
    : 0;
  const convertedToBw = useBlackWhiteOnly && originalColorPages > 0;

  return {
    copies,
    bwPages,
    colorPages,
    totalPages: state.pdfAnalysis.totalPages,
    originalBwPages,
    originalColorPages,
    bwCostPerCopy,
    colorCostPerCopy,
    totalPerCopy,
    grandTotal: totalPerCopy * copies,
    savingsPerCopy,
    convertedToBw,
    useBlackWhiteOnly,
    printModeLabel: convertedToBw
      ? "Black & White only"
      : originalColorPages > 0
        ? "Original color mix"
        : "Black & White",
  };
}

function refreshPricingPreview() {
  const summary = buildPricingSummary();

  if (state.isAnalyzingPdf) {
    renderAnalysisLoadingState();
    updateBlackWhiteModeUi(null);
    return;
  }

  if (!summary) {
    elements.costDisplay.classList.add("is-hidden");
    elements.costDisplay.classList.remove("is-analyzing");
    elements.analysisBadgeText.classList.remove("is-working");
    elements.analysisBadgeText.textContent = "Calculated from uploaded PDF";
    elements.copiesPreview.textContent = String(getCopiesValue());
    elements.totalPrice.textContent = formatCurrency(0);
    elements.grandTotalLine.textContent = formatCurrency(0);
    updateBlackWhiteModeUi(null);
    return;
  }

  elements.bwCount.textContent = String(summary.bwPages);
  elements.colorCount.textContent = String(summary.colorPages);
  elements.totalPages.textContent = String(summary.totalPages);
  elements.copiesPreview.textContent = String(summary.copies);
  elements.costPerCopy.textContent = formatCurrency(summary.totalPerCopy);
  elements.totalPrice.textContent = formatCurrency(summary.grandTotal);
  elements.analysisBadgeText.textContent = summary.convertedToBw
    ? "B/W-only print-ready mode"
    : "Calculated from uploaded PDF";
  elements.bwPricingLine.textContent =
    `${summary.bwPages} pages x ${formatCurrency(APP_CONFIG.pricing.bw)} = ${formatCurrency(summary.bwCostPerCopy)} per copy`;
  elements.colorPricingLine.textContent = summary.convertedToBw
    ? "Color charges removed. All pages will be converted into black and white for printing."
    : `${summary.colorPages} pages x ${formatCurrency(APP_CONFIG.pricing.color)} = ${formatCurrency(summary.colorCostPerCopy)} per copy`;
  elements.grandTotalLine.textContent = summary.convertedToBw
    ? `${formatCurrency(summary.totalPerCopy)} x ${summary.copies} copies = ${formatCurrency(summary.grandTotal)} | You save ${formatCurrency(
        summary.savingsPerCopy * summary.copies
      )}`
    : `${formatCurrency(summary.totalPerCopy)} x ${summary.copies} copies = ${formatCurrency(summary.grandTotal)}`;
  elements.costDisplay.classList.remove("is-analyzing");
  elements.analysisBadgeText.classList.remove("is-working");
  elements.costDisplay.classList.remove("is-hidden");
  updateBlackWhiteModeUi(summary);
}

function renderAnalysisLoadingState() {
  const progress = state.analysisProgress || {};
  const processedPages = Number(progress.processedPages || 0);
  const totalPages = Number(progress.totalPages || 0);

  elements.analysisBadgeText.textContent = totalPages
    ? `Analyzing ${processedPages}/${totalPages} pages`
    : "Opening PDF...";
  elements.analysisBadgeText.classList.add("is-working");
  elements.bwCount.textContent = String(progress.bwPages || 0);
  elements.colorCount.textContent = String(progress.colorPages || 0);
  elements.totalPages.textContent = totalPages > 0 ? String(totalPages) : "--";
  elements.copiesPreview.textContent = String(getCopiesValue());
  elements.costPerCopy.textContent = "Calculating...";
  elements.totalPrice.textContent = "Calculating...";
  elements.bwPricingLine.textContent = totalPages > 0
    ? `${processedPages} of ${totalPages} pages scanned for exact pricing.`
    : "Opening the PDF and reading the page count...";
  elements.colorPricingLine.textContent =
    "Please wait a moment. The system is checking each page to separate black & white pages from color pages.";
  elements.grandTotalLine.textContent = "Price will appear automatically as soon as the scan finishes.";
  elements.costDisplay.classList.add("is-analyzing");
  elements.costDisplay.classList.remove("is-hidden");
}

function renderPaymentSession({ restartTimer, resetConfirmationFields, keepScroll }) {
  const order = state.currentOrder;
  if (!order) {
    return;
  }

  elements.paymentAmount.textContent = formatCurrency(order.amount);
  elements.orderIdDisplay.textContent = order.orderId;
  elements.paymentDetails.textContent =
    `${order.document.bwPages} B/W pages + ${order.document.colorPages} color pages | ` +
    `${order.document.copies} copies | ${formatCurrency(order.document.pricePerCopy)} per copy | ${getOrderPrintModeLabel(order)}`;

  elements.paymentSection.classList.remove("is-hidden");
  elements.paymentSuccess.classList.add("is-hidden");
  elements.timerChip.classList.remove("is-expired");

  if (resetConfirmationFields) {
    elements.paymentApp.value = "";
    elements.transactionId.value = "";
    elements.payerUpiId.value = "";
    elements.gpayLaunchButton.disabled = false;
    elements.phonePeLaunchButton.disabled = false;
    elements.confirmPaymentButton.disabled = false;
    elements.upiLaunchButton.disabled = false;
    elements.copyUpiButton.disabled = false;
  }

  clearPaymentFeedback();
  setPaymentSessionState(true);
  setPaymentProgress("pay");
  setPaymentMethod(state.paymentMethod || "upi");
  createUpiQr();

  if (restartTimer && state.paymentMethod === "upi") {
    startPaymentTimer();
  } else if (state.paymentMethod !== "upi") {
    window.clearInterval(state.timerIntervalId);
    state.timerExpired = false;
    elements.timerChip.classList.remove("is-expired");
  }

  if (!keepScroll) {
    scrollToElementWithHeaderOffset(elements.paymentSection, { duration: 420 });
  }
}

function setPaymentSessionState(isActive) {
  document.body.classList.toggle("has-active-payment-session", Boolean(isActive));
}

function getStickyHeaderOffset() {
  const header = document.querySelector(".site-header");
  const headerHeight = header ? header.getBoundingClientRect().height : 0;
  return headerHeight + 18;
}

function scrollToElementWithHeaderOffset(element, options = {}) {
  if (!element) {
    return;
  }

  const top = Math.max(
    0,
    window.scrollY + element.getBoundingClientRect().top - getStickyHeaderOffset() - Number(options.extraOffset || 0)
  );
  const duration = Math.max(0, Number(options.duration || 460));
  const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  const focusTarget = options.focusTarget || null;

  highlightScrollTarget(element);

  if (prefersReducedMotion || duration < 80 || typeof window.requestAnimationFrame !== "function") {
    window.scrollTo(0, top);
    if (focusTarget) {
      focusTarget.focus({ preventScroll: true });
    }
    return;
  }

  const startY = window.scrollY;
  const delta = top - startY;
  if (Math.abs(delta) < 2) {
    if (focusTarget) {
      focusTarget.focus({ preventScroll: true });
    }
    return;
  }

  window.cancelAnimationFrame(state.scrollAnimationFrameId);
  const startTime = performance.now();

  const step = (currentTime) => {
    const progress = Math.min(1, (currentTime - startTime) / duration);
    const eased = 1 - Math.pow(1 - progress, 3);
    window.scrollTo(0, Math.round(startY + delta * eased));

    if (progress < 1) {
      state.scrollAnimationFrameId = window.requestAnimationFrame(step);
      return;
    }

    state.scrollAnimationFrameId = null;
    if (focusTarget) {
      focusTarget.focus({ preventScroll: true });
    }
  };

  state.scrollAnimationFrameId = window.requestAnimationFrame(step);
}

function highlightScrollTarget(element) {
  if (!element) {
    return;
  }

  element.classList.remove("scroll-target-glow");
  window.clearTimeout(state.scrollTargetTimerId);
  window.requestAnimationFrame(() => {
    element.classList.add("scroll-target-glow");
  });
  state.scrollTargetTimerId = window.setTimeout(() => {
    element.classList.remove("scroll-target-glow");
  }, 1300);
}

function handleQuickScrollLink(event) {
  const link = event.currentTarget;
  const targetId = link?.dataset?.scrollTarget;
  const target = targetId ? document.getElementById(targetId) : null;

  if (!target) {
    return;
  }

  event.preventDefault();
  history.replaceState(null, "", `#${targetId}`);
  scrollToElementWithHeaderOffset(target, {
    duration: 380,
  });
}

function setPaymentProgress(step) {
  const orderedSteps = ["review", "pay", "receipt"];
  const activeIndex = orderedSteps.indexOf(step);

  elements.paymentProgressItems.forEach((item) => {
    const itemIndex = orderedSteps.indexOf(item.dataset.paymentStep);
    item.classList.toggle("is-active", itemIndex === activeIndex);
    item.classList.toggle("is-complete", itemIndex > -1 && itemIndex < activeIndex);
  });
}

function buildUpiLink() {
  if (!state.currentOrder) {
    return "";
  }

  return buildUpiUri();
}

function buildUpiParams() {
  if (!state.currentOrder) {
    return new URLSearchParams();
  }

  const params = {
    pa: APP_CONFIG.upiId,
    pn: APP_CONFIG.businessName,
    am: state.currentOrder.amount.toFixed(2),
    cu: "INR",
    tn: `Print Order ${state.currentOrder.orderId}`,
    tr: state.currentOrder.orderId,
    url: buildOrderReferenceUrl(),
  };

  if (APP_CONFIG.upiMerchantCode) {
    params.mc = APP_CONFIG.upiMerchantCode;
  }

  return new URLSearchParams(params);
}

function buildUpiUri({ scheme = "upi", path = "pay" } = {}) {
  return `${scheme}://${path}?${buildUpiParams().toString()}`;
}

function buildOrderReferenceUrl() {
  if (!state.currentOrder) {
    return window.location.href;
  }

  try {
    return new URL(`/#order-${state.currentOrder.orderId}`, window.location.origin).toString();
  } catch {
    return window.location.href;
  }
}

function buildUpiQrImageUrl(upiLink) {
  const qrUrl = new URL("/api/upi/qr", window.location.origin);
  qrUrl.searchParams.set("data", upiLink);
  return qrUrl.toString();
}

function buildAndroidUpiIntent(packageName) {
  return `intent://pay?${buildUpiParams().toString()}#Intent;scheme=upi;package=${packageName};end`;
}

function isAndroidDevice() {
  return /android/i.test(navigator.userAgent || "");
}

function isIosDevice() {
  const userAgent = navigator.userAgent || "";
  return /iphone|ipad|ipod/i.test(userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function buildPreferredUpiLaunchLink(appKey) {
  const appConfig = UPI_APP_CONFIG[appKey];
  if (!appConfig) {
    return buildUpiLink();
  }

  if (appKey === "gpay") {
    return buildUpiUri({
      scheme: "gpay",
      path: "upi/pay",
    });
  }

  if (isAndroidDevice()) {
    return buildAndroidUpiIntent(appConfig.androidPackage);
  }

  if (isIosDevice() && appConfig.iosScheme) {
    return buildUpiUri({
      scheme: appConfig.iosScheme,
      path: appConfig.iosPath || "pay",
    });
  }

  return buildUpiLink();
}

function navigateToDeepLink(url) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function openUpiLink(preferredLink, fallbackLink = "") {
  window.clearTimeout(state.upiFallbackTimerId);

  if (!preferredLink) {
    return;
  }

  let appOpened = false;
  const handleVisibilityChange = () => {
    if (document.hidden) {
      appOpened = true;
      window.clearTimeout(state.upiFallbackTimerId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    }
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);

  if (fallbackLink && fallbackLink !== preferredLink) {
    state.upiFallbackTimerId = window.setTimeout(() => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (!appOpened && !document.hidden) {
        window.location.href = fallbackLink;
      }
    }, 900);
  }

  navigateToDeepLink(preferredLink);

  window.setTimeout(() => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, 2200);
}

function createUpiQr() {
  elements.qrCode.innerHTML = "";

  const upiLink = buildUpiLink();
  state.currentOrder.payment = {
    method: "upi",
    app: "",
    transactionId: "",
    payerUpiId: "",
    paidAt: "",
    upiLink,
  };

  if (!upiLink) {
    elements.qrCode.innerHTML = "<p>QR generation failed. Use the UPI button instead.</p>";
    showToast("QR code could not be generated.", true);
    return;
  }

  const qrImage = document.createElement("img");
  qrImage.src = buildUpiQrImageUrl(upiLink);
  qrImage.alt = "UPI payment QR code";
  qrImage.width = 220;
  qrImage.height = 220;
  qrImage.decoding = "async";

  qrImage.addEventListener("error", () => {
    elements.qrCode.innerHTML = "<p>QR generation failed. Use the UPI button instead.</p>";
    showToast("QR code could not be generated.", true);
  });

  elements.qrCode.appendChild(qrImage);
}

function startPaymentTimer() {
  window.clearInterval(state.timerIntervalId);
  state.timerExpired = false;
  state.paymentExpiresAt = Date.now() + APP_CONFIG.paymentTimeoutMinutes * 60 * 1000;
  updateTimerDisplay();
  state.timerIntervalId = window.setInterval(updateTimerDisplay, 1000);
}

function updateTimerDisplay() {
  const remainingMs = Math.max(0, state.paymentExpiresAt - Date.now());
  const minutes = Math.floor(remainingMs / 60000);
  const seconds = Math.floor((remainingMs % 60000) / 1000);
  elements.paymentTimer.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

  if (remainingMs > 0) {
    return;
  }

  state.timerExpired = true;
  window.clearInterval(state.timerIntervalId);
  elements.timerChip.classList.add("is-expired");
  elements.gpayLaunchButton.disabled = true;
  elements.phonePeLaunchButton.disabled = true;
  elements.confirmPaymentButton.disabled = true;
  elements.upiLaunchButton.disabled = true;
  elements.copyUpiButton.disabled = true;
  showPaymentFeedback(
    "Payment session expired. Review the order again to generate a fresh amount and QR code before confirming.",
    "error"
  );
}

function setPaymentMethod(method) {
  state.paymentMethod = method;
  elements.methodTabs.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.method === method);
  });
  elements.upiPanel.classList.toggle("is-hidden", method !== "upi");
  elements.codPanel.classList.toggle("is-hidden", method !== "cod");
  elements.timerChip.classList.toggle("is-hidden", method !== "upi");
  showDefaultPaymentFeedback();
}

function launchUpiApp() {
  if (!state.currentOrder) {
    showPaymentFeedback("Please review the order details first so the correct UPI amount is generated.", "error");
    return;
  }

  if (state.timerExpired) {
    showPaymentFeedback("The payment timer expired. Review the order again to generate a fresh UPI amount.", "error");
    return;
  }

  state.currentOrder.payment.upiLink = buildUpiLink();
  registerExternalPaymentAttempt({
    appKey: "generic-upi",
    appLabel: elements.paymentApp.value.trim() || "UPI app",
  });
  openUpiLink(state.currentOrder.payment.upiLink);
}

function launchNamedUpiApp(appKey) {
  if (!state.currentOrder) {
    showPaymentFeedback("Please review the order details first so the correct UPI amount is generated.", "error");
    return;
  }

  if (state.timerExpired) {
    showPaymentFeedback("The payment timer expired. Review the order again to generate a fresh UPI amount.", "error");
    return;
  }

  const appConfig = UPI_APP_CONFIG[appKey];
  if (!appConfig) {
    launchUpiApp();
    return;
  }

  elements.paymentApp.value = appConfig.label;
  state.currentOrder.payment.upiLink = buildUpiLink();
  registerExternalPaymentAttempt({
    appKey,
    appLabel: appConfig.label,
  });
  showPaymentFeedback(
    `${isIosDevice() ? `Opening ${appConfig.label} on iPhone. After payment, switch back to Safari and submit the transaction ID and your UPI ID.` : `Opening ${appConfig.label}. Complete the payment there, then return here and submit the transaction ID and your UPI ID.`} If the app shows a payment error, use the QR code or the main UPI button and then continue below with the same order amount.`,
    "info"
  );
  openUpiLink(buildPreferredUpiLaunchLink(appKey), state.currentOrder.payment.upiLink);
}

function registerExternalPaymentAttempt({ appKey, appLabel }) {
  state.externalPaymentAttempt = {
    appKey: String(appKey || ""),
    appLabel: String(appLabel || "UPI app"),
    leftPage: false,
    returned: false,
    launchedAt: Date.now(),
  };
}

function handlePaymentAppVisibilityChange() {
  const attempt = state.externalPaymentAttempt;
  if (!attempt || state.paymentMethod !== "upi") {
    return;
  }

  if (document.hidden) {
    attempt.leftPage = true;
    return;
  }

  if (!attempt.leftPage || attempt.returned || elements.paymentSection.classList.contains("is-hidden")) {
    return;
  }

  attempt.returned = true;
  showPaymentFeedback(
    buildReturnedFromPaymentAppMessage(attempt),
    isGooglePayAttempt(attempt) ? "warning" : "info"
  );
}

function buildReturnedFromPaymentAppMessage(attempt) {
  if (isGooglePayAttempt(attempt)) {
    return `Back from Google Pay. If Google Pay said "Your payment has not been debited" or that your bank account transaction limit was exceeded, the payment failed and no money was taken. Switch to another bank account or UPI app and retry. Only enter the transaction ID below if the payment succeeded.`;
  }

  return `Back from ${attempt.appLabel || "your UPI app"}. If the app showed that the payment failed or the amount was not debited, do not confirm payment yet. Retry with another bank account, use another UPI app, or scan the QR code. Only enter the transaction ID below if the payment succeeded.`;
}

function isGooglePayAttempt(attempt) {
  return /gpay|google pay/i.test(String(attempt?.appKey || "")) ||
    /google pay/i.test(String(attempt?.appLabel || ""));
}

async function copyUpiId() {
  try {
    await navigator.clipboard.writeText(APP_CONFIG.upiId);
    showToast("UPI ID copied.");
  } catch (error) {
    showToast("Could not copy the UPI ID on this device.", true);
  }
}

async function confirmUpiPayment(event) {
  event.preventDefault();

  if (!state.currentOrder) {
    showPaymentFeedback("Order details are missing. Review the order again before confirming payment.", "error");
    return;
  }

  if (state.timerExpired) {
    showPaymentFeedback("The payment session expired. Review the order again to generate a fresh amount.", "error");
    return;
  }

  const app = elements.paymentApp.value.trim();
  const transactionId = normaliseTransactionId(elements.transactionId.value);
  const payerUpiId = normaliseUpiId(elements.payerUpiId.value);

  if (!app) {
    showPaymentFeedback("Select the UPI app used for payment.", "error");
    elements.paymentApp.focus();
    return;
  }

  if (!isValidTransactionId(transactionId)) {
    showPaymentFeedback(
      "Enter the exact UPI transaction/reference ID shown by the payment app.",
      "error"
    );
    elements.transactionId.focus();
    return;
  }

  if (!isValidUpiId(payerUpiId)) {
    showPaymentFeedback("Enter a valid UPI ID, for example yourname@okaxis.", "error");
    elements.payerUpiId.focus();
    return;
  }

  elements.transactionId.value = transactionId;
  elements.payerUpiId.value = payerUpiId;

  state.currentOrder.payment = {
    method: "upi",
    app,
    transactionId,
    payerUpiId,
    paidAt: new Date().toISOString(),
    upiLink: buildUpiLink(),
  };

  clearPaymentFeedback();
  await submitOrderConfirmation();
}

async function confirmCodOrder() {
  if (!state.currentOrder) {
    showPaymentFeedback("Order details are missing. Review the order again before confirming pickup.", "error");
    return;
  }

  state.currentOrder.payment = {
    method: "cod",
    app: "Cash on Pickup",
    transactionId: "",
    payerUpiId: "",
    paidAt: new Date().toISOString(),
    upiLink: "",
  };

  clearPaymentFeedback();
  await submitOrderConfirmation();
}

async function submitOrderConfirmation() {
  toggleSubmitting(true);

  try {
    const pricing = buildPricingSummary();
    showPaymentFeedback(
      pricing?.convertedToBw
        ? "Preparing the high-contrast B/W PDF, validating the payment details, and generating your receipt."
        : state.paymentMethod === "cod"
          ? "Creating the pickup order and generating the receipt."
          : "Validating the payment details and generating your receipt.",
      "working"
    );
    const payload = await buildConfirmationPayload();
    const response = await fetch("/api/orders/confirm", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result = await readJsonResponse(response);

    if (!response.ok || !result.success) {
      throw new Error(
        result.error ||
        result.message ||
        (response.status >= 500
          ? "We could not verify the order right now. Please try again in a moment."
          : "Order confirmation failed.")
      );
    }

    handleSuccessfulConfirmation(result);
  } catch (error) {
    showPaymentFeedback(getFriendlyConfirmationErrorMessage(error), "error");
  } finally {
    toggleSubmitting(false);
  }
}

function handleSuccessfulConfirmation(result) {
  window.clearInterval(state.timerIntervalId);
  elements.timerChip.classList.remove("is-expired");
  elements.upiPanel.classList.add("is-hidden");
  elements.codPanel.classList.add("is-hidden");
  elements.paymentSuccess.classList.remove("is-hidden");
  clearPaymentFeedback();
  setPaymentProgress("receipt");

  const receipt = result.receipt || {};
  const isCod = receipt.paymentMethod === "Cash on Pickup";
  const isBwOnly = receipt.printMode === "bw-only";
  const hasDeliveryWarnings = Array.isArray(result.warnings) && result.warnings.length > 0;
  elements.successTitle.textContent = isCod
    ? "Order Confirmed for Pickup."
    : hasDeliveryWarnings
      ? "Payment Recorded Successfully."
      : "Payment Completed Successfully.";
  elements.successLead.textContent = isCod
    ? isBwOnly
      ? "Your pickup order is locked in, the receipt is ready, and the print desk has the black-and-white file instructions."
      : "Your pickup order is locked in, the receipt is ready, and the print desk has the customer PDF."
    : hasDeliveryWarnings
      ? "Your receipt is ready. Automatic owner/customer delivery needs a retry, but the order has been safely recorded on the server."
      : isBwOnly
        ? "Your payment is verified, the B/W print-ready file is ready, and the receipt will download automatically."
        : "Your payment is verified, the receipt is ready, and the print desk has received the customer PDF.";

  const bytes = Uint8Array.from(atob(result.invoiceBase64), (char) => char.charCodeAt(0));
  state.invoiceBlob = new Blob([bytes], { type: "application/pdf" });
  state.invoiceFileName = result.invoiceFileName;
  state.lastSuccessResponse = result;

  renderDeliveryStatus(result);
  history.replaceState(null, "", "#paymentSuccess");
  window.requestAnimationFrame(() => {
    scrollToElementWithHeaderOffset(elements.paymentSuccess, { duration: 420, extraOffset: 8 });
    elements.paymentSuccess.focus({ preventScroll: true });
  });
  downloadInvoice();
}

function renderDeliveryStatus(result) {
  const receipt = result.receipt || {};
  const currentOrder = state.currentOrder || {};
  const verificationItems = (result.verification?.checks || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  const warnings = Array.isArray(result.warnings) && result.warnings.length > 0
    ? `
      <div class="receipt-alert">
        <strong>Attention needed:</strong>
        <ul class="receipt-alert-list">
          ${result.warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
        </ul>
      </div>
    `
    : "";

  elements.deliveryStatus.innerHTML = `
    <div class="receipt-overview">
      <article class="receipt-highlight">
        <span>Total Price</span>
        <strong>${formatCurrency(receipt.totalPrice || result.amount)}</strong>
        <small>${escapeHtml(receipt.paymentStatus || "Payment Successful")}</small>
      </article>
      <article class="receipt-overview-card">
        <span>Order ID</span>
        <strong>${escapeHtml(receipt.orderId || result.orderId)}</strong>
        <small>${escapeHtml(receipt.documentName || currentOrder.document?.fileName || "Document")}</small>
      </article>
      <article class="receipt-overview-card">
        <span>Date & Time</span>
        <strong>${escapeHtml(formatDateTime(receipt.paidAt || new Date().toISOString()))}</strong>
        <small>${escapeHtml(receipt.paymentMethod || "UPI")}</small>
      </article>
    </div>

    ${warnings}

    <section class="receipt-section">
      <div class="receipt-section-head">
        <div>
          <p class="receipt-kicker">Payment Slip</p>
          <h4>Verified payment details</h4>
        </div>
        <span class="status-pill">${escapeHtml(receipt.paymentStatus || "Payment Successful")}</span>
      </div>
      <div class="receipt-grid">
        ${renderReceiptItem("Customer Name", receipt.customerName || currentOrder.customer?.name || "NA")}
        ${renderReceiptItem("Email ID", receipt.customerEmail || currentOrder.customer?.email || "NA")}
        ${renderReceiptItem("UPI ID", receipt.payerUpiId || result.verification?.payerUpiId || "NA")}
        ${renderReceiptItem("Transaction ID", receipt.transactionId || result.verification?.transactionId || "NA")}
        ${renderReceiptItem("Number of Copies", String(receipt.copies || currentOrder.document?.copies || "0"))}
        ${renderReceiptItem("Color Pages Count", String(receipt.colorPages || currentOrder.document?.colorPages || "0"))}
        ${renderReceiptItem("Black & White Pages Count", String(receipt.bwPages || currentOrder.document?.bwPages || "0"))}
        ${renderReceiptItem("Total Price", formatCurrency(receipt.totalPrice || result.amount))}
        ${renderReceiptItem("Payment Status", receipt.paymentStatus || "Payment Successful")}
        ${renderReceiptItem("Date & Time", formatDateTime(receipt.paidAt || new Date().toISOString()))}
      </div>
    </section>

    <section class="receipt-section receipt-section-soft">
      <div class="receipt-section-head">
        <div>
          <p class="receipt-kicker">Delivery</p>
          <h4>Attachments and notifications</h4>
        </div>
      </div>
      <div class="receipt-notifications">
        <div class="receipt-note">
          <strong>Customer invoice:</strong> ${escapeHtml(
            result.emails?.deliveryFailed
              ? `Pending automatic delivery to ${result.emails?.customer || receipt.customerEmail || "the customer inbox"}`
              : `Sent to ${result.emails?.customer || receipt.customerEmail || "NA"}`
          )}
        </div>
        <div class="receipt-note">
          <strong>Owner print file:</strong> ${escapeHtml(
            result.attachments?.originalPdfForwardedToOwner
              ? `${result.attachments.originalPdfFileName} forwarded to ${receipt.ownerEmail || result.emails?.owner || "print desk email"}`
              : result.attachments?.originalPdfStoredOnServer
                ? `${result.attachments?.originalPdfFileName || "Customer PDF"} saved on the server for manual follow-up`
                : "Forwarding status unavailable"
          )}
        </div>
        <div class="receipt-note">
          <strong>Print mode:</strong> ${escapeHtml(
            receipt.printMode === "bw-only"
              ? "Black & White only - all pages converted before sending"
              : receipt.printModeLabel || "Original color mix"
          )}
        </div>
        <div class="receipt-note">
          <strong>Invoice download:</strong> ${escapeHtml(result.invoiceFileName || "Ready")}
        </div>
      </div>
      <div class="receipt-verification">
        <h5>Verification checks</h5>
        <ul class="receipt-checks">
          ${verificationItems || "<li>No verification checks were returned.</li>"}
        </ul>
      </div>
    </section>
  `;
}

function downloadInvoice() {
  if (!state.invoiceBlob) {
    showToast("Invoice is not ready yet.", true);
    return;
  }

  const url = URL.createObjectURL(state.invoiceBlob);
  const link = document.createElement("a");
  link.href = url;
  link.download = state.invoiceFileName || `${state.currentOrder?.orderId || "invoice"}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function toggleSubmitting(isSubmitting) {
  elements.gpayLaunchButton.disabled = isSubmitting || state.timerExpired;
  elements.phonePeLaunchButton.disabled = isSubmitting || state.timerExpired;
  elements.confirmPaymentButton.disabled = isSubmitting || state.timerExpired;
  elements.confirmCodButton.disabled = isSubmitting;
  elements.upiLaunchButton.disabled = isSubmitting || state.timerExpired;
  elements.copyUpiButton.disabled = isSubmitting || state.timerExpired;
  elements.confirmPaymentButton.classList.toggle("is-loading", isSubmitting);
  elements.confirmCodButton.classList.toggle("is-loading", isSubmitting);

  if (isSubmitting) {
    elements.confirmPaymentButton.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span> Verifying Payment';
    elements.confirmCodButton.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span> Creating Order';
  } else {
    elements.confirmPaymentButton.innerHTML = '<i class="fas fa-circle-check"></i> Confirm Payment';
    elements.confirmCodButton.innerHTML = '<i class="fas fa-receipt"></i> Confirm Pickup Order';
  }
}

function resetPendingPaymentSession() {
  window.clearInterval(state.timerIntervalId);
  state.currentOrder = null;
  state.paymentExpiresAt = null;
  state.timerExpired = false;
  window.clearTimeout(state.upiFallbackTimerId);
  state.externalPaymentAttempt = null;
  setPaymentSessionState(false);
  elements.paymentSection.classList.add("is-hidden");
  elements.paymentSuccess.classList.add("is-hidden");
  elements.deliveryStatus.innerHTML = "";
  elements.qrCode.innerHTML = "";
  clearPaymentFeedback();
  setPaymentProgress("review");
}

function clearCompletedOrderArtifacts() {
  state.invoiceBlob = null;
  state.invoiceFileName = "";
  state.lastSuccessResponse = null;
}

function isPendingPaymentSessionVisible() {
  return !elements.paymentSection.classList.contains("is-hidden") &&
    elements.paymentSuccess.classList.contains("is-hidden");
}

function getCopiesValue() {
  const numeric = Number(elements.copies.value);
  const safeCopies = Number.isFinite(numeric) ? Math.max(1, Math.min(100, Math.floor(numeric))) : 1;
  if (String(safeCopies) !== elements.copies.value) {
    elements.copies.value = String(safeCopies);
  }
  return safeCopies;
}

async function buildConfirmationPayload() {
  if (!state.currentOrder) {
    throw new Error("Order details are missing.");
  }

  return {
    ...state.currentOrder,
    upload: await serializeSelectedPdf(),
  };
}

async function serializeSelectedPdf() {
  const file = elements.fileInput.files[0];

  if (!file || !isPdfFile(file)) {
    throw new Error("Please upload the customer PDF again before confirming payment.");
  }

  if (file.size > getMaxForwardablePdfBytes()) {
    throw new Error(`PDF must stay within ${getMaxForwardablePdfMb()} MB for email forwarding.`);
  }

  const summary = buildPricingSummary();
  return {
    fileName: file.name,
    contentType: file.type || "application/pdf",
    size: file.size,
    base64: await readBlobAsBase64(file),
  };
}

async function serializeBlackWhitePdf(file) {
  const processedUpload = await ensureBlackWhitePdfPrepared(file);

  return {
    fileName: processedUpload.fileName,
    contentType: "application/pdf",
    size: processedUpload.blob.size,
    base64: await readBlobAsBase64(processedUpload.blob),
  };
}

function readBlobAsBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const result = String(reader.result || "");
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };

    reader.onerror = () => reject(new Error("The uploaded PDF could not be prepared for email delivery."));
    reader.readAsDataURL(blob);
  });
}

function getUploadKey(file) {
  return file ? `${file.name}:${file.size}:${file.lastModified}` : "";
}

function clearProcessedBwCache() {
  state.processedBwUpload = null;
  state.processedBwPromise = null;
}

function updateBlackWhiteModeUi(summary = buildPricingSummary()) {
  if (state.isAnalyzingPdf) {
    elements.bwModeToggle.disabled = true;
    elements.bwModeToggle.checked = state.forceBlackWhite;
    elements.bwModeStatus.textContent = "Analyzing PDF";
    elements.bwModeHint.textContent =
      "We are scanning the PDF first so the black-and-white savings can be calculated accurately.";
    elements.bwSavingsBanner.classList.add("is-hidden");
    return;
  }

  const hasAnalysis = Boolean(summary && state.pdfAnalysis);
  const hasColorPages = Boolean(summary?.originalColorPages > 0);
  const exportUnavailable = hasAnalysis && hasColorPages && !hasBlackWhiteConversionTools();

  if (exportUnavailable && state.forceBlackWhite) {
    state.forceBlackWhite = false;
    clearProcessedBwCache();
    summary = buildPricingSummary();
  }

  elements.bwModeToggle.disabled = !hasAnalysis || exportUnavailable;
  elements.bwModeToggle.checked = state.forceBlackWhite;

  if (!hasAnalysis) {
    elements.bwModeStatus.textContent = "Upload PDF first";
    elements.bwModeHint.textContent =
      "Upload a PDF to compare the standard color mix with the cheaper B/W-only printing option.";
    elements.bwSavingsBanner.classList.add("is-hidden");
    return;
  }

  if (exportUnavailable) {
    elements.bwModeStatus.textContent = "Unavailable right now";
    elements.bwModeHint.textContent =
      "Black-and-white PDF export is temporarily unavailable, so this order will continue with the original color mix.";
    elements.bwSavingsBanner.classList.add("is-hidden");
    return;
  }

  if (!hasColorPages) {
    elements.bwModeStatus.textContent = state.forceBlackWhite ? "Already B/W" : "Already low cost";
    elements.bwModeHint.textContent =
      "This PDF already appears to be black and white, so the B/W mode keeps the same lower pricing.";
    elements.bwSavingsBanner.classList.add("is-hidden");
    return;
  }

  if (state.forceBlackWhite) {
    elements.bwModeStatus.textContent = "On - cheaper price";
    elements.bwModeHint.textContent =
      `All ${summary.totalPages} pages will be converted into a high-contrast black-and-white print-ready PDF on confirmation.`;
    elements.bwSavingsTitle.textContent = `B/W mode saves ${formatCurrency(summary.savingsPerCopy * summary.copies)} on this order`;
    elements.bwSavingsText.textContent =
      "Color charges are removed, and the confirmed order will be exported as a crisp high-contrast black-and-white PDF.";
    elements.bwSavingsBanner.classList.remove("is-hidden");
    elements.bwSavingsBanner.classList.add("is-active");
    return;
  }

  elements.bwModeStatus.textContent = `Off - save ${formatCurrency(summary.originalColorPages * Math.max(APP_CONFIG.pricing.color - APP_CONFIG.pricing.bw, 0))} /copy`;
  elements.bwModeHint.textContent =
    `Keep the original color pages, or switch to B/W-only mode to save ${formatCurrency(summary.originalColorPages * Math.max(APP_CONFIG.pricing.color - APP_CONFIG.pricing.bw, 0))} per copy.`;
  elements.bwSavingsTitle.textContent = "Cheaper B/W option available";
  elements.bwSavingsText.textContent =
    `Turn this on to convert all pages into black and white and save ${formatCurrency(summary.savingsPerCopy || summary.originalColorPages * Math.max(APP_CONFIG.pricing.color - APP_CONFIG.pricing.bw, 0))} per copy.`;
  elements.bwSavingsBanner.classList.remove("is-hidden");
  elements.bwSavingsBanner.classList.remove("is-active");
}

async function warmBlackWhitePdfCache(file) {
  try {
    await ensureBlackWhitePdfPrepared(file);
  } catch {
    // Keep this silent here and surface the error only if the user actually confirms the order.
  }
}

async function ensureBlackWhitePdfPrepared(file) {
  const key = getUploadKey(file);

  if (state.processedBwUpload?.key === key) {
    return state.processedBwUpload;
  }

  if (state.processedBwPromise) {
    return state.processedBwPromise;
  }

  const promise = createBlackWhitePdfUpload(file)
    .then((processedUpload) => {
      const currentFile = elements.fileInput.files[0];
      if (getUploadKey(currentFile) === key) {
        state.processedBwUpload = processedUpload;
      }
      return processedUpload;
    })
    .finally(() => {
      if (state.processedBwPromise === promise) {
        state.processedBwPromise = null;
      }
      updateBlackWhiteModeUi();
    });

  state.processedBwPromise = promise;
  updateBlackWhiteModeUi();
  return promise;
}

async function createBlackWhitePdfUpload(file) {
  const jsPdfCtor = window.jspdf?.jsPDF;
  if (!jsPdfCtor || !window.pdfjsLib) {
    throw new Error("Black-and-white PDF export is temporarily unavailable. Continue with the original PDF and try again later.");
  }

  const sourceBytes = new Uint8Array(await file.arrayBuffer());
  const sourcePdf = await window.pdfjsLib.getDocument({ data: sourceBytes }).promise;
  const variants = sourcePdf.numPages > 12
    ? [
        { scale: 1.05, quality: 0.72, compression: "FAST" },
        { scale: 0.92, quality: 0.58, compression: "FAST" },
      ]
    : [
        { scale: 1.2, quality: 0.8, compression: "MEDIUM" },
        { scale: 1.05, quality: 0.68, compression: "FAST" },
      ];

  let bestBlob = null;

  for (const variant of variants) {
    const blob = await renderPdfAsBlackWhiteBlob(sourcePdf, jsPdfCtor, variant);
    bestBlob = blob;
    if (blob.size <= getMaxForwardablePdfBytes()) {
      return {
        key: getUploadKey(file),
        fileName: buildProcessedPdfFileName(file.name),
        blob,
      };
    }
  }

  throw new Error(
    `The black and white print-ready PDF is still above ${getMaxForwardablePdfMb()} MB. Please upload a smaller PDF or keep the original file.`
  );
}

async function renderPdfAsBlackWhiteBlob(sourcePdf, jsPdfCtor, variant) {
  let pdfDoc = null;

  for (let pageNumber = 1; pageNumber <= sourcePdf.numPages; pageNumber += 1) {
    const page = await sourcePdf.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const renderViewport = page.getViewport({ scale: variant.scale });
    const orientation = baseViewport.width > baseViewport.height ? "landscape" : "portrait";

    if (!pdfDoc) {
      pdfDoc = new jsPdfCtor({
        orientation,
        unit: "pt",
        format: [baseViewport.width, baseViewport.height],
        compress: true,
      });
    } else {
      pdfDoc.addPage([baseViewport.width, baseViewport.height], orientation);
    }

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    canvas.width = Math.max(1, Math.floor(renderViewport.width));
    canvas.height = Math.max(1, Math.floor(renderViewport.height));
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvasContext: context,
      viewport: renderViewport,
    }).promise;

    applyGrayscaleToCanvas(context, canvas.width, canvas.height);
    const imageData = canvas.toDataURL("image/jpeg", variant.quality);
    pdfDoc.addImage(
      imageData,
      "JPEG",
      0,
      0,
      baseViewport.width,
      baseViewport.height,
      undefined,
      variant.compression
    );

    canvas.width = 0;
    canvas.height = 0;
  }

  return pdfDoc.output("blob");
}

function applyGrayscaleToCanvas(context, width, height) {
  const imageData = context.getImageData(0, 0, width, height);
  const { data } = imageData;

  for (let index = 0; index < data.length; index += 4) {
    const gray = Math.round(data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114);
    data[index] = gray;
    data[index + 1] = gray;
    data[index + 2] = gray;
  }

  context.putImageData(imageData, 0, 0);
}

function buildProcessedPdfFileName(fileName) {
  const baseName = String(fileName || "document").replace(/\.pdf$/i, "");
  return `${baseName}-bw.pdf`;
}

function yieldToBrowser() {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function isPdfFile(file) {
  return file && (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"));
}

function getMaxForwardablePdfMb() {
  return Number(APP_CONFIG.maxForwardablePdfMb || 18);
}

function getMaxForwardablePdfBytes() {
  return getMaxForwardablePdfMb() * 1024 * 1024;
}

function normaliseTransactionId(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

function normaliseUpiId(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function isValidTransactionId(value) {
  return /^[A-Z0-9._-]{8,40}$/.test(value);
}

function isValidUpiId(value) {
  return /^[a-z0-9._-]{2,}@[a-z][a-z0-9.-]{1,}$/i.test(value);
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

function normalisePhone(phone) {
  return String(phone || "").replace(/\s+/g, "");
}

function formatCurrency(amount) {
  return `Rs ${Number(amount || 0).toFixed(2).replace(/\.00$/, "")}`;
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: true,
  }).format(new Date(value));
}

function getOrderPrintModeLabel(order) {
  return order.document?.printModeLabel ||
    (order.document?.printMode === "bw-only"
      ? "Black & White only"
      : order.document?.colorPages > 0
        ? "Original color mix"
        : "Black & White");
}

function renderReceiptItem(label, value) {
  return `
    <article class="receipt-item">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </article>
  `;
}

function getFriendlyPdfAnalysisErrorMessage(error) {
  const message = String(error?.message || "").trim();
  if (!message) {
    return "The PDF could not be analyzed. Please try another file.";
  }
  if (/spawn eperm|python|local server/i.test(message)) {
    return "PDF analysis could not start on the local server. Restart the app server and try the PDF again.";
  }
  if (/tools are still loading|pdfjs|worker/i.test(message)) {
    return "PDF tools are still loading. Please wait a moment and select the file again.";
  }
  if (/password/i.test(message)) {
    return "This PDF is password protected. Please upload an unlocked PDF for pricing.";
  }
  return "The PDF could not be analyzed. Please try another file or a cleaner PDF export.";
}

async function readJsonResponse(response) {
  const raw = await response.text();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return {
      success: response.ok,
      message: raw,
    };
  }
}

function getFriendlyConfirmationErrorMessage(error) {
  const message = String(error?.message || "").trim();
  if (!message) {
    return "Could not confirm the order right now.";
  }
  if (/failed to fetch|networkerror/i.test(message)) {
    return "Could not reach the confirmation service. Please check the connection and try again.";
  }
  if (/unexpected token|json/i.test(message)) {
    return "The confirmation response could not be read. Please try again.";
  }
  return message;
}

function showDefaultPaymentFeedback() {
  if (!elements.paymentFeedback) {
    return;
  }

  if (elements.paymentSection.classList.contains("is-hidden")) {
    return;
  }

  if (state.paymentMethod === "cod") {
    showPaymentFeedback(
      "Cash on pickup will create the receipt immediately, and payment will stay pending until collection.",
      "info"
    );
    return;
  }

  if (state.timerExpired) {
    showPaymentFeedback(
      "Payment session expired. Review the order again to generate a fresh amount and QR code.",
      "error"
    );
    return;
  }

  const pricing = buildPricingSummary();
  showPaymentFeedback(
    pricing?.convertedToBw
      ? "After payment, submit the exact transaction ID and payer UPI ID. If the UPI app said the amount was not debited or your bank limit was exceeded, do not confirm yet."
      : "After payment, submit the exact transaction ID and payer UPI ID to verify the order and open the receipt below. If the payment app said the amount was not debited, retry first instead of confirming.",
    "info"
  );
}

function showPaymentFeedback(message, variant = "info") {
  if (!elements.paymentFeedback) {
    return;
  }

  const iconByVariant = {
    info: "fa-circle-info",
    warning: "fa-triangle-exclamation",
    working: "fa-spinner fa-spin",
    error: "fa-circle-exclamation",
    success: "fa-circle-check",
  };

  elements.paymentFeedback.innerHTML = `
    <i class="fas ${iconByVariant[variant] || iconByVariant.info}" aria-hidden="true"></i>
    <span>${escapeHtml(message)}</span>
  `;
  elements.paymentFeedback.className = `payment-feedback is-${variant}`;
}

function clearPaymentFeedback() {
  if (!elements.paymentFeedback) {
    return;
  }

  elements.paymentFeedback.textContent = "";
  elements.paymentFeedback.className = "payment-feedback is-hidden";
}

function handleTransactionIdInput() {
  elements.transactionId.value = normaliseTransactionId(elements.transactionId.value);
  showDefaultPaymentFeedback();
}

function handlePayerUpiIdInput() {
  elements.payerUpiId.value = normaliseUpiId(elements.payerUpiId.value);
  showDefaultPaymentFeedback();
}

function startFreshOrder() {
  elements.uploadForm.reset();
  elements.fileInput.value = "";
  elements.fileName.textContent = "No PDF selected yet.";
  state.pdfAnalysis = null;
  state.forceBlackWhite = false;
  state.paymentMethod = "upi";
  clearProcessedBwCache();
  clearCompletedOrderArtifacts();
  resetPendingPaymentSession();
  refreshPricingPreview();
  history.replaceState(null, "", "#uploadForm");
  scrollToElementWithHeaderOffset(elements.uploadForm, {
    duration: 360,
  });
}

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("is-error", isError);
  elements.toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    elements.toast.classList.remove("is-visible");
  }, 3600);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
