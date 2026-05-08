import json
import sys

import fitz


COLOR_DELTA = 12
COLOR_RATIO_THRESHOLD = 0.04
MIN_VISIBLE_PIXELS_FOR_EARLY_EXIT = 140
PDF_SAVE_OPTIONS = {
    "garbage": 3,
    "deflate": True,
    "deflate_images": True,
    "deflate_fonts": True,
    "use_objstms": 1,
}
IMAGE_REWRITE_VARIANTS = [
    {"dpi_threshold": 300, "dpi_target": 220, "quality": 92},
    {"dpi_threshold": 240, "dpi_target": 180, "quality": 88},
    {"dpi_threshold": 200, "dpi_target": 150, "quality": 84},
]


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


def recolor_document_to_grayscale(doc: fitz.Document) -> None:
    if hasattr(doc, "recolor"):
        doc.recolor(components=1)
        return

    for page in doc:
        page.recolor(components=1)


def write_pdf_bytes(doc: fitz.Document) -> bytes:
    return doc.write(**PDF_SAVE_OPTIONS)


def create_bw_pdf_bytes(input_path: str, rewrite_profile: dict | None = None) -> bytes:
    with fitz.open(input_path) as source_doc:
        recolor_document_to_grayscale(source_doc)
        if rewrite_profile:
            source_doc.rewrite_images(
                dpi_threshold=rewrite_profile["dpi_threshold"],
                dpi_target=rewrite_profile["dpi_target"],
                quality=rewrite_profile["quality"],
                lossy=True,
                lossless=True,
                bitonal=True,
                color=True,
                gray=True,
            )
        return write_pdf_bytes(source_doc)


def convert_pdf_to_bw(input_path: str, output_path: str, max_bytes: int = 0) -> dict:
    with fitz.open(input_path) as source_doc:
        best_pdf_bytes = create_bw_pdf_bytes(input_path)
        conversion_mode = "grayscale-recolor"
        selected_profile = None

        if max_bytes and len(best_pdf_bytes) > max_bytes:
            for profile in IMAGE_REWRITE_VARIANTS:
                candidate_pdf_bytes = create_bw_pdf_bytes(input_path, profile)

                if len(candidate_pdf_bytes) < len(best_pdf_bytes):
                    best_pdf_bytes = candidate_pdf_bytes
                    conversion_mode = "grayscale-recolor-image-rewrite"
                    selected_profile = profile

                if len(candidate_pdf_bytes) <= max_bytes:
                    best_pdf_bytes = candidate_pdf_bytes
                    conversion_mode = "grayscale-recolor-image-rewrite"
                    selected_profile = profile
                    break

        if max_bytes and len(best_pdf_bytes) > max_bytes:
            raise ValueError(
                "Black-and-white conversion could not stay within the email size limit while preserving the original layout quality."
            )

        with open(output_path, "wb") as target:
            target.write(best_pdf_bytes)

        result = {
            "size": len(best_pdf_bytes),
            "pageCount": source_doc.page_count,
            "conversionMode": conversion_mode,
        }
        if selected_profile:
            result["imageRewrite"] = selected_profile
        return result


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
