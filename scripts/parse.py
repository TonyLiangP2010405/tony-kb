#!/usr/bin/env python3
"""IPAV 文档解析器：把每个文件解析为纯文本，输出 JSONL（每行一条记录）。

用法：
    python parse.py <文件清单> > output.jsonl

输入：一个文本文件，每行一个文件绝对路径。
输出：stdout 为 JSONL，每行 {"path":..., "ext":..., "rel":..., "text":...}

支持的格式：
    .txt .md        直接读取
    .docx           标准库 zipfile 解析 word/document.xml
    .xlsx           标准库 zipfile 解析 sharedStrings.xml + sheet XML
    .pdf            调用系统 pdftotext
其他格式跳过（doc/xls 由 Office COM 批次单独转换后再读）。
"""
import sys, os, re, html, zipfile, json, subprocess, unicodedata

# Windows 下 stdout/stderr 默认 GBK，强制 UTF-8 以安全输出任意字符
if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if sys.stderr and hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

EXTS_DIRECT = {".txt", ".md", ".csv", ".tsv", ".json", ".yaml", ".log"}
EXTS_DOCX = {".docx"}
EXTS_XLSX = {".xlsx"}
EXTS_PDF = {".pdf"}

def clean_text(text: str) -> str:
    """规范化文本：统一换行、去除控制字符、压缩空行。"""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # 去除控制字符（保留 \t \n）
    text = "".join(ch for ch in text if ch == "\t" or ch == "\n" or unicodedata.category(ch)[0] != "C")
    text = re.sub(r"[ \t\u00a0]+\n", "\n", text)
    text = re.sub(r"\n[ \t\u00a0]*\n{2,}", "\n\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()

def parse_docx(path: str) -> str:
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8", "ignore")
    xml = xml.replace("</w:p>", "\n").replace("<w:tab/>", "\t").replace("<w:br/>", "\n")
    text = re.sub(r"<[^>]+>", "", xml)
    text = html.unescape(text)
    return clean_text(text)

def parse_xlsx(path: str) -> str:
    """用标准库读取 xlsx 中的文本（shared strings + 各 sheet 单元格）。"""
    parts = []
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            xml = z.read("xl/sharedStrings.xml").decode("utf-8", "ignore")
            # 每个 <si> 是一条第 shared string
            for si in re.findall(r"<si>.*?</si>", xml, re.S):
                si_text = re.sub(r"<[^>]+>", "", si)
                shared.append(html.unescape(si_text))
        # 读取每个 sheet
        for name in z.namelist():
            if not re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name):
                continue
            xml = z.read(name).decode("utf-8", "ignore")
            rows = []
            for row in re.findall(r"<row[^>]*>.*?</row>", xml, re.S):
                cells = []
                for cell in re.findall(r"<c[^>]*>.*?</c>", row, re.S):
                    v = re.search(r"<v>(.*?)</v>", cell, re.S)
                    t = re.search(r'<c[^>]*t="(\w+)"', cell)
                    typ = t.group(1) if t else ""
                    txt = html.unescape(v.group(1)) if v else ""
                    if typ == "s" and txt.isdigit() and int(txt) < len(shared):
                        txt = shared[int(txt)]
                    elif txt:
                        # 数字等，原样保留
                        pass
                    if txt.strip():
                        cells.append(txt.strip())
                if cells:
                    rows.append(" | ".join(cells))
            sheet_text = clean_text("\n".join(rows))
            if sheet_text:
                parts.append(sheet_text)
    return "\n\n".join(parts)

def parse_pdf(path: str) -> str:
    try:
        out = subprocess.run(
            ["pdftotext", path, "-"],
            capture_output=True, timeout=120,
        )
        return clean_text(out.stdout.decode("utf-8", "ignore"))
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as e:
        sys.stderr.write(f"PDF_ERROR\t{path}\t{e}\n")
        return ""

def parse_file(path: str, ext: str) -> str:
    if ext in EXTS_DIRECT:
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                return clean_text(f.read())
        except OSError as e:
            sys.stderr.write(f"READ_ERROR\t{path}\t{e}\n")
            return ""
    if ext in EXTS_DOCX:
        try:
            return parse_docx(path)
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"DOCX_ERROR\t{path}\t{e}\n")
            return ""
    if ext in EXTS_XLSX:
        try:
            return parse_xlsx(path)
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"XLSX_ERROR\t{path}\t{e}\n")
            return ""
    if ext in EXTS_PDF:
        return parse_pdf(path)
    return ""

def main():
    list_path = sys.argv[1]
    with open(list_path, "r", encoding="utf-8") as f:
        paths = [ln.strip() for ln in f if ln.strip()]
    for p in paths:
        ext = os.path.splitext(p)[1].lower()
        text = parse_file(p, ext)
        if not text:
            continue
        rec = {"path": p, "ext": ext, "text": text}
        sys.stdout.write(json.dumps(rec, ensure_ascii=False) + "\n")

if __name__ == "__main__":
    main()