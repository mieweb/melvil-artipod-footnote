# Unlimited-OCR on Google Colab (free GPU) — paste this WHOLE file into ONE Colab cell.
#
# Setup first (30 seconds):
#   1. colab.research.google.com → New notebook
#   2. Runtime → Change runtime type → T4 GPU (or L4 if offered) → Save
#   3. Paste this entire file into the first cell → Run
#   4. When prompted, upload the three IOMSC PDFs from ~/ozwell/footnote/content/
#      (multi-select works)
#   5. At the end it downloads ocr-results.zip — send that (or its .md/.txt files) back.
#
# It runs a prompt experiment ("convert to markdown.") on the first PDF, then the
# standard multi-page parse on all PDFs. Prints per-page timing for the latency story.

pip install -q "transformers==4.57.1" pymupdf pillow accelerate

from google.colab import files
print("Upload the IOMSC PDFs now (multi-select all three)…")
up = files.upload()

import os, time, glob, zipfile, torch, fitz
from transformers import AutoModel, AutoTokenizer

MODEL = "baidu/Unlimited-OCR"
# T4 has no native bf16 — fall back to fp16 there; L4/A100 use bf16.
dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
print("GPU:", torch.cuda.get_device_name(0), "| dtype:", dtype)

tok = AutoTokenizer.from_pretrained(MODEL, trust_remote_code=True)
model = AutoModel.from_pretrained(
    MODEL, trust_remote_code=True, use_safetensors=True, torch_dtype=dtype
).eval().cuda()
print(f"model loaded ({torch.cuda.memory_allocated()/1e9:.1f} GB on GPU)")

def run(pdf, prompt, tag):
    out = ("out_" + os.path.splitext(pdf)[0][:24] + "_" + tag).replace(" ", "_")
    os.makedirs(out, exist_ok=True)
    doc = fitz.open(pdf); pages = []
    for i, pg in enumerate(doc):
        fp = os.path.join(out, f"p{i+1:03d}.png")
        pg.get_pixmap(dpi=200).save(fp)
        pages.append(fp)
    t = time.time()
    model.infer_multi(
        tok, prompt=prompt, image_files=pages, output_path=out,
        image_size=1024, max_length=32768,
        no_repeat_ngram_size=35, ngram_window=1024, save_results=True,
    )
    dt = time.time() - t
    print(f"{pdf} [{tag}]: {len(pages)} pages in {dt:.0f}s ({dt/len(pages):.1f}s/page)")
    return out

pdfs = [f for f in up if f.lower().endswith(".pdf")]
outs = []
# Experiment: does a markdown-flavored prompt make it emit # headings?
outs.append(run(pdfs[0], "<image>convert to markdown.", "mdprompt"))
# Standard mode for every doc (what the Space ran).
for f in pdfs:
    outs.append(run(f, "<image>Multi page parsing.", "parse"))

with zipfile.ZipFile("ocr-results.zip", "w") as z:
    for d in outs:
        for f in glob.glob(d + "/*"):
            if not f.endswith(".png"):
                z.write(f)
print("zipped:", [os.path.basename(d) for d in outs])
files.download("ocr-results.zip")
