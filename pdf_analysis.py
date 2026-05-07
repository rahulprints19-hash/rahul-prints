import io
import json
import sys

import cv2
import fitz
import numpy as np
from PIL import Image, ImageOps


COLOR_DELTA = 12
COLOR_RATIO_THRESHOLD = 0.04
MIN_VISIBLE_PIXELS_FOR_EARLY_EXIT = 140
BITONAL_THRESHOLD_BIAS = 10


def page_has_color(page: fitz.Page) -> bool:
    pix = page.get_pixmap(matrix=fitz.Matrix(0.22, 0.22), alpha=False)
    channels = max(1, pix.n)

    if channels < 3:
        return False

    samples = pix.samples
    color_pixels = 0
    visible_pixels = 0
    pixel_stride = channels * 4

    for index in range(0, len(samples) - (channels - 1), pixel_stride):
        r = samples[index]
        g = samples[index + 1]
        b = samples[index + 2]

        if r > 248 and g > 248 and b > 248:
            continue

        visible_pixels += 1
        if abs(r - g) > COLOR_DELTA or abs(g - b) > COLOR_DELTA or abs(r - b) > COLOR_DELTA:
            color_pixels += 1
            if (
                visible_pixels >= MIN_VISIBLE_PIXELS_FOR_EARLY_EXIT
                and color_pixels / visible_pixels > COLOR_RATIO_THRESHOLD
            ):
                return True

    return visible_pixels > 0 and color_pixels / visible_pixels > COLOR_RATIO_THRESHOLD


def analyze_pdf(pdf_path: str) -> dict:
    with fitz.open(pdf_path) as doc:
        bw_pages = 0
        color_pages = 0

        for page in doc:
            if page_has_color(page):
                color_pages += 1
            else:
                bw_pages += 1

        return {
            "totalPages": doc.page_count,
            "bwPages": bw_pages,
            "colorPages": color_pages,
        }


def build_conversion_variants(page_count: int) -> list[int]:
    if page_count <= 8:
        return [420, 360, 300]
    if page_count <= 20:
        return [360, 300, 240]
    if page_count <= 40:
        return [300, 260, 220]
    return [260, 220, 200]


def create_bitonal_page_png(page: fitz.Page, dpi: int) -> bytes:
    scale = dpi / 72
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
    samples = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)

    if pix.n >= 3:
        gray = cv2.cvtColor(samples[:, :, :3], cv2.COLOR_RGB2GRAY)
    else:
        gray = samples[:, :, 0]

    contrasted = ImageOps.autocontrast(Image.fromarray(gray, mode="L"), cutoff=1)
    contrasted_array = np.array(contrasted)

    threshold_value, _ = cv2.threshold(
        contrasted_array,
        0,
        255,
        cv2.THRESH_BINARY + cv2.THRESH_OTSU,
    )
    threshold_value = min(245, int(threshold_value) + BITONAL_THRESHOLD_BIAS)
    bitonal_array = cv2.threshold(
        contrasted_array,
        threshold_value,
        255,
        cv2.THRESH_BINARY,
    )[1]

    image = Image.fromarray(bitonal_array, mode="L").convert("1")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True, compress_level=9)
    return buffer.getvalue()


def create_bw_pdf_bytes(input_path: str, dpi: int) -> bytes:
    with fitz.open(input_path) as source_doc:
        with fitz.open() as converted_doc:
            for source_page in source_doc:
                page_rect = source_page.rect
                page_png = create_bitonal_page_png(source_page, dpi)
                target_page = converted_doc.new_page(width=page_rect.width, height=page_rect.height)
                target_page.insert_image(target_page.rect, stream=page_png, keep_proportion=False)

            return converted_doc.write(
                garbage=3,
                deflate=True,
                deflate_images=True,
                deflate_fonts=True,
                use_objstms=1,
            )


def convert_pdf_to_bw(input_path: str, output_path: str, max_bytes: int = 0) -> dict:
    with fitz.open(input_path) as source_doc:
        variants = build_conversion_variants(source_doc.page_count)
        best_pdf_bytes = b""
        selected_dpi = variants[-1]

        for dpi in variants:
            candidate_pdf_bytes = create_bw_pdf_bytes(input_path, dpi)

            if not best_pdf_bytes or len(candidate_pdf_bytes) < len(best_pdf_bytes):
                best_pdf_bytes = candidate_pdf_bytes
                selected_dpi = dpi

            if not max_bytes or len(candidate_pdf_bytes) <= max_bytes:
                best_pdf_bytes = candidate_pdf_bytes
                selected_dpi = dpi
                break

        with open(output_path, "wb") as target:
            target.write(best_pdf_bytes)

        return {
            "size": len(best_pdf_bytes),
            "pageCount": source_doc.page_count,
            "renderDpi": selected_dpi,
        }


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Missing PDF path."}))
        return 1

    try:
        if sys.argv[1] == "convert-bw":
            if len(sys.argv) < 4:
                raise ValueError("Missing input or output path for B/W conversion.")

            max_bytes = int(sys.argv[4]) if len(sys.argv) > 4 else 0
            result = convert_pdf_to_bw(sys.argv[2], sys.argv[3], max_bytes)
        elif sys.argv[1] == "analyze":
            if len(sys.argv) < 3:
                raise ValueError("Missing PDF path for analysis.")

            result = analyze_pdf(sys.argv[2])
        else:
            result = analyze_pdf(sys.argv[1])

        print(json.dumps(result))
        return 0
    except Exception as exc:  # pragma: no cover - runtime guard
        print(json.dumps({"error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
