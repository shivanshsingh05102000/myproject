// client/src/components/PdfEditor.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { Rnd } from "react-rnd";
import SignatureCanvas from "react-signature-canvas";
import { PDFDocument } from "pdf-lib";
import axios from "axios";
import { cssBoxToPdfPoints } from "../lib/Coord";

pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.js`;
const API_BASE = import.meta.env.VITE_API_URL || "";
console.log("DEBUG: API_BASE =", API_BASE);



export default function PdfEditor({ defaultPdf = "/sample.pdf", pdfUrl = null, initialPage = 1 }) {
  const containerRef = useRef(null);
  const pageWrapperRef = useRef(null);
  const sigPadRef = useRef(null);

  // PDF state
  const [pdfUrlState, setPdfUrlState] = useState(pdfUrl);
  const [pdfData, setPdfData] = useState(null);
  const [pdfBlob, setPdfBlob] = useState(null);
  const [blobUrl, setBlobUrl] = useState(null);
  const [pdfIdState, setPdfIdState] = useState(null);
  const [uploading, setUploading] = useState(false);

  // pages/viewer
  const [numPages, setNumPages] = useState(null);
  const [activePage, setActivePage] = useState(Number(initialPage) || 1);

  // responsive / sizing
  const [viewerWidth, setViewerWidth] = useState(800);
  const [isMobile, setIsMobile] = useState(false);

  // measurements & page pts
  const [renderedSizes, setRenderedSizes] = useState({});
  const [canvasOffsets, setCanvasOffsets] = useState({});
  const [pageSizePointsMap, setPageSizePointsMap] = useState({});

  // boxes & selection
  const [boxes, setBoxes] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [signatureBase64, setSignatureBase64] = useState(null);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [localFileName, setLocalFileName] = useState(null);

  // adopt external pdfUrl changes
  useEffect(() => {
    if (pdfUrl) {
      setPdfUrlState(pdfUrl);
      setPdfData(null);
      setPdfBlob(null);
      setBoxes([]);
      setSelectedIds(new Set());
      setSignatureBase64(null);
      setLocalFileName(null);
      setPdfIdState(null);
    }
  }, [pdfUrl]);

  // load default pdf bytes when needed
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (pdfUrlState || pdfData || pdfBlob) return;
        const res = await axios.get(defaultPdf, { responseType: "arraybuffer" });
        if (cancelled) return;
        const ab = res.data;
        const copy = new Uint8Array(ab.byteLength);
        copy.set(new Uint8Array(ab));
        setPdfData(copy);
      } catch (err) {
        console.warn("Could not fetch default PDF:", err);
      }
    })();
    return () => (cancelled = true);
  }, [defaultPdf, pdfUrlState, pdfData, pdfBlob]);

  const fileProp = useMemo(() => {
    if (pdfUrlState) return pdfUrlState;
    if (blobUrl) return blobUrl;
    if (pdfData) return { data: pdfData };
    return defaultPdf;
  }, [pdfUrlState, blobUrl, pdfData, defaultPdf]);

  // responsive handling: switch layout on small widths and compute viewerWidth
  useEffect(() => {
    function recompute() {
      const w = Math.max(320, Math.min(1000, Math.floor((containerRef.current?.clientWidth || window.innerWidth) - 40)));
      setViewerWidth(w);
      const mobile = (window.innerWidth || 0) < 900;
      setIsMobile(mobile);
    }
    recompute();
    const ro = new ResizeObserver(recompute);
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener("resize", recompute);
    return () => {
      try { ro.disconnect(); } catch { }
      window.removeEventListener("resize", recompute);
    };
  }, []);

  // revoke blob URL when pdfBlob changes
  useEffect(() => {
    if (!pdfBlob) {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
        setBlobUrl(null);
      }
      return;
    }
    const u = URL.createObjectURL(pdfBlob);
    setBlobUrl(u);
    return () => {
      URL.revokeObjectURL(u);
    };
  }, [pdfBlob]);

  // ---------- UPLOAD: client-side hash, check, upload ----------
  async function sha256HexOfFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    const subtle = (typeof window !== "undefined" && window.crypto && window.crypto.subtle) ? window.crypto.subtle : (crypto && crypto.subtle ? crypto.subtle : null);
    if (!subtle) {
      // fallback: simple non-crypto placeholder (shouldn't happen in modern browsers)
      const buf = new Uint8Array(arrayBuffer);
      let hex = "";
      for (let i = 0; i < buf.length; i++) hex += buf[i].toString(16).padStart(2, "0");
      return hex;
    }
    const hashBuffer = await subtle.digest("SHA-256", arrayBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function uploadPdfFile(file) {
    try {
      if (!file) return alert("No file selected");
      if (file.type !== "application/pdf") return alert("Please select a PDF file");

      // 1) compute SHA-256 on client
      const pdfHash = await sha256HexOfFile(file);

      // 2) ask server if hash already exists
      try {
        const checkResp = await axios.post(`${API_BASE}/api/check-pdf`, { hash: pdfHash }, { timeout: 10000 });
        if (checkResp?.data?.exists) {
          const { url, doc } = checkResp.data;
          const load = window.confirm(
            "This PDF has been uploaded before. Do you want to load the existing file instead of uploading?\n\n" +
            "If you choose OK the existing document will be loaded into the viewer."
          );
          if (load) {
            const fullUrl = url && url.startsWith('http') ? url : `${API_BASE}${url || ''}`;
            setPdfUrlState(fullUrl);
            setPdfIdState(doc?.pdfId || null); // important so signing works
            setPdfData(null);
            setPdfBlob(null);
            setLocalFileName(null);
            setBoxes([]); // optionally clear boxes
            setSelectedIds(new Set());
            setSignatureBase64(null);
            alert("Loaded existing PDF from server.");
            return;
          }
          // else fallthrough to upload again
        }
      } catch (e) {
        console.warn("check-pdf failed; continuing to upload", e);
      }

      // 3) upload file (include hash so server can save record)
      const fd = new FormData();
      fd.append("file", file);
      fd.append("pdfHash", pdfHash);

      setUploading(true);
      const res = await axios.post(`${API_BASE}/api/upload-pdf`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 120000,
      });

      if (!res.data?.success) {
        alert("Upload failed: " + (res.data?.error || "Unknown error"));
        return;
      }

      const { pdfId, url } = res.data;
      const fullUrl = url && url.startsWith("http") ? url : `${API_BASE}${url || ""}`;

      setPdfIdState(pdfId);
      setPdfUrlState(fullUrl);
      setPdfData(null);
      setPdfBlob(null);
      setLocalFileName(null);
      setBoxes([]);
      setSelectedIds(new Set());
      setSignatureBase64(null);

      alert("PDF uploaded and loaded into viewer (server).");
    } catch (err) {
      console.error("upload error", err);
      alert("Upload error: " + (err?.response?.data?.error || err.message || "unknown"));
    } finally {
      setUploading(false);
    }
  }

  // ---------- Document load and page sizes ----------
  async function onDocumentLoadSuccess(pdf) {
    setNumPages(pdf.numPages || null);
    try {
      const map = {};
      for (let i = 1; i <= (pdf.numPages || 0); i++) {
        try {
          const page = await pdf.getPage(i);
          const view = page.view;
          if (view && view.length >= 4) {
            map[i] = { width: Math.abs(view[2] - view[0]), height: Math.abs(view[3] - view[1]) };
          } else {
            map[i] = { width: 595, height: 842 };
          }
        } catch (e) {
          map[i] = { width: 595, height: 842 };
        }
      }
      setPageSizePointsMap(map);
    } catch (e) {
      console.warn("Could not read page sizes:", e);
    }
  }

  // measure active page overlay placement
  function measureActivePage() {
    const wrapper = pageWrapperRef.current;
    if (!wrapper) return;
    const canvases = wrapper.querySelectorAll("canvas");
    const wrapperRect = wrapper.getBoundingClientRect();

    let width = Math.round(wrapperRect.width);
    let height = Math.round(wrapperRect.height);
    let left = 0;
    let top = 0;

    if (canvases.length > 0) {
      const largest = Array.from(canvases).sort((a, b) => b.width * b.height - a.width * a.height)[0];
      const canvasRect = largest.getBoundingClientRect();
      width = Math.round(canvasRect.width);
      height = Math.round(canvasRect.height);
      left = Math.round(canvasRect.left - wrapperRect.left);
      top = Math.round(canvasRect.top - wrapperRect.top);
    }

    setRenderedSizes((prev) => {
      const p = prev[activePage];
      if (!p || p.width !== width || p.height !== height) {
        return { ...prev, [activePage]: { width, height } };
      }
      return prev;
    });

    setCanvasOffsets((prev) => {
      const p = prev[activePage];
      if (!p || p.left !== left || p.top !== top) {
        return { ...prev, [activePage]: { left, top } };
      }
      return prev;
    });
  }

  // re-measure when active page, viewer width, or number of pages change
  useEffect(() => {
    const id = setTimeout(() => measureActivePage(), 80);
    return () => clearTimeout(id);
  }, [activePage, viewerWidth, numPages]);

  // boxes helpers
  function addBox() {
    const pageRendered = renderedSizes[activePage] || { width: viewerWidth, height: Math.round(viewerWidth * 1.3) };
    const defaultW = Math.round(pageRendered.width * 0.3);
    const defaultH = Math.round(defaultW * 0.35);
    const left = Math.max(8, Math.round(pageRendered.width * 0.1));
    const top = Math.max(8, Math.round(pageRendered.height * 0.6));
    setBoxes((s) => [
      ...s,
      {
        id: Date.now().toString(),
        left,
        top,
        width: defaultW,
        height: defaultH,
        pageIndex: activePage,
        x_frac: left / (pageRendered.width || 1),
        y_frac: top / (pageRendered.height || 1),
        w_frac: defaultW / (pageRendered.width || 1),
        h_frac: defaultH / (pageRendered.height || 1),
      },
    ]);
  }

  function updateBox(id, patch) {
    setBoxes((s) =>
      s.map((b) => {
        if (b.id !== id) return b;
        const updated = { ...b, ...patch };
        if (patch.left !== undefined || patch.top !== undefined || patch.width !== undefined || patch.height !== undefined) {
          const size = renderedSizes[updated.pageIndex] || { width: viewerWidth, height: Math.round(viewerWidth * 1.3) };
          const x_frac = Math.max(0, Math.min(1, (updated.left || 0) / (size.width || 1)));
          const y_frac = Math.max(0, Math.min(1, (updated.top || 0) / (size.height || 1)));
          const w_frac = Math.max(0, Math.min(1, (updated.width || 0) / (size.width || 1)));
          const h_frac = Math.max(0, Math.min(1, (updated.height || 0) / (size.height || 1)));
          return { ...updated, x_frac, y_frac, w_frac, h_frac };
        }
        return updated;
      })
    );
  }

  function removeBox(id) {
    setBoxes((s) => s.filter((b) => b.id !== id));
    setSelectedIds((prev) => {
      const c = new Set(prev);
      c.delete(id);
      return c;
    });
  }

  // selection
  function toggleSelect(id) {
    setSelectedIds((prev) => {
      const c = new Set(prev);
      if (c.has(id)) c.delete(id);
      else c.add(id);
      return c;
    });
  }
  function selectAllOnPage(page) {
    setSelectedIds((prev) => {
      const c = new Set(prev);
      boxes.filter((b) => b.pageIndex === page).forEach((b) => c.add(b.id));
      return c;
    });
  }
  function selectAll() {
    setSelectedIds(new Set(boxes.map((b) => b.id)));
  }
  function clearSelection() {
    setSelectedIds(new Set());
  }

  function getPageOffsetAndSize(pageIndexOne) {
    const offset = canvasOffsets[pageIndexOne] || { left: 0, top: 0 };
    const size = renderedSizes[pageIndexOne] || { width: viewerWidth, height: Math.round(viewerWidth * 1.3) };
    return { offset, size };
  }

  function exportCoords(box) {
    const pageIndexOne = Number(box.pageIndex) || 1;
    const { offset, size } = getPageOffsetAndSize(pageIndexOne);
    const localLeft = box.left - (offset.left || 0);
    const localTop = box.top - (offset.top || 0);
    const cssBox = { left: localLeft, top: localTop, width: box.width, height: box.height };
    const pagePts = pageSizePointsMap[pageIndexOne] || { width: 595, height: 842 };
    const { pdfBox, fractions } = cssBoxToPdfPoints(cssBox, size, pagePts);
    const pageIndexZero = Math.max(0, pageIndexOne - 1);
    return { pageIndex: pageIndexZero, pdfBox, fractions, pageSizePoints: pagePts };
  }

  // signature capture/upload
  function captureSignature() {
    if (!sigPadRef.current) return;
    try {
      const dataUrl = sigPadRef.current.getTrimmedCanvas().toDataURL("image/png");
      setSignatureBase64(dataUrl);
    } catch (err) {
      console.error("captureSignature failed", err);
      alert("Could not capture signature: " + (err.message || err));
    }
  }
  function clearSignature() {
    if (sigPadRef.current) sigPadRef.current.clear();
    setSignatureBase64(null);
  }
  function uploadSignatureFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setSignatureBase64(reader.result);
    reader.readAsDataURL(file);
  }

  // load local file
  async function loadLocalPdfFile(file) {
    if (!file) return alert("No file provided");
    if (file.type !== "application/pdf") return alert("Please select a PDF file");
    try {
      const blob = file.slice(0, file.size, "application/pdf");
      setPdfBlob(blob);
      setLocalFileName(file.name || "local.pdf");
      setPdfUrlState(null);
      setPdfIdState(null);
      setBoxes([]);
      setSelectedIds(new Set());
      setSignatureBase64(null);
      alert("Loaded PDF locally — ready to edit");
    } catch (err) {
      console.error("loadLocalPdfFile error", err);
      alert("Failed to load PDF: " + (err?.message || err));
    }
  }

  // burn multiple (local)
  async function burnInLocallyMultiple(exportedItems, signatureDataUrl, outName = "signed.pdf") {
    try {
      let src = null;
      if (pdfBlob instanceof Blob) {
        const ab = await pdfBlob.arrayBuffer();
        src = new Uint8Array(ab);
      } else if (pdfData instanceof Uint8Array) {
        const out = new Uint8Array(pdfData.length);
        out.set(pdfData);
        src = out;
      } else if (pdfUrlState) {
        const resp = await fetch(pdfUrlState);
        const ab = await resp.arrayBuffer();
        src = new Uint8Array(ab);
      }

      if (!src) return { success: false, error: "No PDF available. Reload the file or upload it first." };

      let headerAscii = "";
      try {
        headerAscii = new TextDecoder().decode(src.slice(0, 5));
      } catch (e) {
        headerAscii = null;
      }
      if (!headerAscii || headerAscii.indexOf("%PDF") !== 0) {
        const hex = Array.from(src.slice(0, 64)).map((b) => b.toString(16).padStart(2, "0")).join(" ");
        const msg = `Invalid PDF header (${String(headerAscii)}). First bytes (hex): ${hex}`;
        console.error(msg);
        return { success: false, error: msg };
      }

      const pdfDoc = await PDFDocument.load(src);

      if (!signatureDataUrl || !signatureDataUrl.includes(",")) throw new Error("Signature data URL invalid");
      const [meta, base64] = signatureDataUrl.split(",");
      if (!base64) throw new Error("Signature base64 missing");
      const isPng = meta.includes("image/png");
      const imgUint8 = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const image = isPng ? await pdfDoc.embedPng(imgUint8) : await pdfDoc.embedJpg(imgUint8);

      for (const it of exportedItems) {
        const pageIndexZero = it.pageIndex;
        const pdfBox = it.pdfBox;
        const page = pdfDoc.getPage(pageIndexZero);
        if (!page) continue;

        const imgW = image.width;
        const imgH = image.height;
        const imgRatio = imgW / imgH;
        const boxW = pdfBox.width;
        const boxH = pdfBox.height;
        const boxRatio = boxW / boxH;

        let drawW, drawH;
        if (imgRatio > boxRatio) {
          drawW = boxW;
          drawH = boxW / imgRatio;
        } else {
          drawH = boxH;
          drawW = boxH * imgRatio;
        }

        const offsetX = pdfBox.x + (boxW - drawW) / 2;
        const offsetY = pdfBox.y + (boxH - drawH) / 2;

        page.drawImage(image, { x: offsetX, y: offsetY, width: drawW, height: drawH });
      }

      const outBytes = await pdfDoc.save();
      const blob = new Blob([outBytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = outName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 15000);
      return { success: true, url };
    } catch (err) {
      console.error("burnInLocallyMultiple failed", err);
      return { success: false, error: err.message || String(err) };
    }
  }

  // sign selected (server or local)
  async function signSelected() {
    if (!signatureBase64) return alert("No signature captured or uploaded.");
    const ids = Array.from(selectedIds);
    if (!ids.length) return alert("No boxes selected.");
    const selectedBoxes = boxes.filter((b) => ids.includes(b.id));
    if (!selectedBoxes.length) return alert("Selected boxes not found.");
    const exportedItems = selectedBoxes.map((b) => exportCoords(b));

    let srcPreview = null;
    if (pdfBlob instanceof Blob) {
      const ab = await pdfBlob.arrayBuffer();
      srcPreview = new Uint8Array(ab);
    } else if (pdfData instanceof Uint8Array) {
      const out = new Uint8Array(pdfData.length);
      out.set(pdfData);
      srcPreview = out;
    }

    if (srcPreview) {
      setLoading(true);
      try {
        const filenameSafe = (localFileName || "local").replace(/\.[^.]+$/, "") + `-signed-selected-${Date.now()}.pdf`;
        const r = await burnInLocallyMultiple(exportedItems, signatureBase64, filenameSafe);
        if (!r.success) throw new Error(r.error || "Local multi-sign failed");
        alert("Signed PDF downloaded locally (selected boxes).");
      } catch (err) {
        console.error(err);
        alert("Local sign failed: " + (err?.message || err));
      } finally {
        setLoading(false);
      }
      return;
    }

    try {
      setLoading(true);
      const payload = {
        pdfId: pdfIdState || "",
        items: exportedItems,
        signatureBase64,
      };
      if (!payload.pdfId) return alert("No server PDF selected. Upload first or load locally.");
      const res = await axios.post(`${API_BASE}/api/sign-pdf-multi`, payload, { timeout: 120000 });
      if (!res?.data) throw new Error("Empty response");
      const { url } = res.data;
      if (url) {
        const signedUrl = url.startsWith("http") ? url : `${API_BASE}${url}`;
        window.open(signedUrl, "_blank");
      } else {
        alert("Signed but server did not return URL");
      }
    } catch (err) {
      console.error("Sign failed", err);
      alert("Sign failed: " + (err?.response?.data?.error || err?.message || "unknown"));
    } finally {
      setLoading(false);
    }
  }

  // sign all pages (server or local)
  async function signAllPages() {
    if (!signatureBase64) return alert("No signature captured or uploaded.");
    if (!boxes.length) return alert("No signature boxes in document.");
    const exportedItems = boxes.map((b) => exportCoords(b));

    let srcPreview = null;
    if (pdfBlob instanceof Blob) {
      const ab = await pdfBlob.arrayBuffer();
      srcPreview = new Uint8Array(ab);
    } else if (pdfData instanceof Uint8Array) {
      const out = new Uint8Array(pdfData.length);
      out.set(pdfData);
      srcPreview = out;
    }

    if (srcPreview) {
      setLoading(true);
      try {
        const filenameSafe = (localFileName || "local").replace(/\.[^.]+$/, "") + `-signed-all-${Date.now()}.pdf`;
        const r = await burnInLocallyMultiple(exportedItems, signatureBase64, filenameSafe);
        if (!r.success) throw new Error(r.error || "Local multi-sign failed");
        alert("Signed PDF downloaded locally (all boxes).");
      } catch (err) {
        console.error(err);
        alert("Local sign failed: " + (err?.message || err));
      } finally {
        setLoading(false);
      }
      return;
    }

    try {
      setLoading(true);
      const payload = {
        pdfId: pdfIdState || "",
        items: exportedItems,
        signatureBase64,
      };
      if (!payload.pdfId) return alert("No server PDF selected. Upload first or load locally.");
      const res = await axios.post(`${API_BASE}/api/sign-pdf-multi`, payload, { timeout: 120000 });
      if (!res?.data) throw new Error("Empty response");
      const { url } = res.data;
      if (url) {
        const signedUrl = url.startsWith("http") ? url : `${API_BASE}${url}`;
        window.open(signedUrl, "_blank");
      } else {
        alert("Signed but server did not return URL");
      }
    } catch (err) {
      console.error("Sign failed", err);
      alert("Sign failed: " + (err?.response?.data?.error || err?.message || "unknown"));
    } finally {
      setLoading(false);
    }
  }

  // pagination numbers
  function renderPageNumbers() {
    if (!numPages) return null;
    const out = [];
    for (let i = 1; i <= numPages; i++) {
      out.push(
        <button
          key={`pg-${i}`}
          onClick={() => setActivePage(i)}
          style={{
            padding: "6px 8px",
            margin: 4,
            borderRadius: 4,
            background: i === activePage ? "#16a34a" : "#f1f5f9",
            color: i === activePage ? "#fff" : "#0f172a",
            border: "none",
            cursor: "pointer",
          }}
        >
          {i}
        </button>
      );
    }
    return out;
  }

  // boxes on active page
  const boxesForActivePage = boxes.filter((b) => Number(b.pageIndex) === Number(activePage));

  // UI layout: responsive column ordering
  return (
    <div
      ref={containerRef}
      style={{
        display: "flex",
        flexDirection: isMobile ? "column" : "row",
        gap: 12,
        padding: 12,
        boxSizing: "border-box",
        alignItems: "stretch",
      }}
    >
      {/* Controls: on top for mobile, right for desktop */}
      <div
        style={{
          width: isMobile ? "100%" : 380,
          order: isMobile ? 0 : 1,
          boxSizing: "border-box",
          padding: 12,
          borderRadius: 8,
          background: "#fff",
          boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
        }}
      >
        <h3 style={{ margin: 0 }}>Tools</h3>

        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={addBox}>Add Signature (active page)</button>
            <button onClick={signSelected} disabled={loading || selectedIds.size === 0} style={{ background: "#2563eb", color: "#fff" }}>{loading ? "Signing…" : `Sign selected (${selectedIds.size})`}</button>
            <button onClick={signAllPages} disabled={loading || boxes.length === 0} style={{ background: "#065f46", color: "#fff" }}>{loading ? "Signing…" : `Sign all (${boxes.length})`}</button>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => selectAllOnPage(activePage)}>Select all on page</button>
            <button onClick={selectAll}>Select all</button>
            <button onClick={clearSelection}>Clear selection</button>
          </div>

          <hr />

          <div>
            <label><strong>Upload PDF (server)</strong></label><br />
            <input type="file" accept="application/pdf" onChange={(e) => uploadPdfFile(e.target.files?.[0])} />
            {uploading && <div style={{ color: "blue" }}>Uploading...</div>}
            <div style={{ fontSize: 12, color: "#475569", marginTop: 6 }}>Uploaded file will be stored on server and used for server-side signing.</div>
          </div>

          <hr />

          <div>
            <h4 style={{ marginTop: 0 }}>Signature</h4>
            <SignatureCanvas ref={sigPadRef} penColor="black" canvasProps={{ width: 320, height: 120, className: "sigCanvas" }} />
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button onClick={captureSignature}>Capture</button>
              <button onClick={clearSignature}>Clear</button>
              <label style={{ display: "inline-block", marginLeft: 6, fontSize: 12 }}>{signatureBase64 ? "Captured" : "No signature"}</label>
            </div>
            <div style={{ marginTop: 8 }}>
              <label style={{ display: "block", marginBottom: 6 }}>Upload signature image</label>
              <input type="file" accept="image/*" onChange={(e) => uploadSignatureFile(e.target.files?.[0])} />
            </div>
          </div>

          <hr />

          <div>
            <label style={{ display: "block", marginBottom: 6 }}>Load PDF locally (file input or drag & drop)</label>
            <input type="file" accept="application/pdf" onChange={(e) => { const f = e.target.files?.[0]; if (f) loadLocalPdfFile(f); e.target.value = ""; }} />
            <div style={{ fontSize: 12, color: "#475569", marginTop: 6 }}>Local mode: edits & signing happen in browser; no server upload.</div>
          </div>

          <hr />

          <div style={{ fontSize: 13 }}>
            <div>Active: Page {activePage}{numPages ? ` / ${numPages}` : ""}</div>
            <div style={{ marginTop: 6 }}>Boxes: {boxes.length} • Selected: {selectedIds.size}</div>
            <div style={{ marginTop: 6 }}>Loaded: {pdfIdState ? `${pdfIdState} (server)` : (localFileName || "default sample (local)")}</div>
          </div>
        </div>
      </div>

      {/* Viewer column */}
      <div style={{ flex: 1, order: isMobile ? 1 : 0, display: "flex", flexDirection: "column" }}>
        {/* Page area: bounded and top-aligned so top is visible in fullscreen */}
        <div
          style={{
            padding: 12,
            background: "#fff",
            borderRadius: 8,
            boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
            boxSizing: "border-box",
            height: isMobile ? "60vh" : "calc(80vh - 32px)",
            overflow: "auto",
            display: "block",
            alignItems: "flex-start",
            justifyContent: "flex-start",
          }}
        >
          <Document file={fileProp} onLoadSuccess={onDocumentLoadSuccess} loading={<div>Loading PDF…</div>}>
            <div
              ref={pageWrapperRef}
              style={{
                position: "relative",
                display: "inline-block",
                width: viewerWidth,
                marginTop: 8,
                marginBottom: 8,
              }}
            >
              <Page
                pageNumber={activePage}
                width={viewerWidth}
                onRenderSuccess={() => {
                  setTimeout(() => measureActivePage(), 50);
                }}
                renderTextLayer={false}
                renderAnnotationLayer={false}
              />

              {/* overlay anchored inside page wrapper */}
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  left: (canvasOffsets[activePage]?.left || 0),
                  top: (canvasOffsets[activePage]?.top || 0),
                  width: (renderedSizes[activePage]?.width || viewerWidth),
                  height: (renderedSizes[activePage]?.height || Math.round(viewerWidth * 1.3)),
                  pointerEvents: "none",
                }}
              >
                {boxesForActivePage.map((b) => {
                  const isSelected = selectedIds.has(b.id);
                  return (
                    <Rnd
                      key={b.id}
                      bounds="parent"
                      size={{ width: b.width, height: b.height }}
                      position={{ x: b.left - (canvasOffsets[activePage]?.left || 0), y: b.top - (canvasOffsets[activePage]?.top || 0) }}
                      onDragStop={(e, d) => updateBox(b.id, { left: d.x + (canvasOffsets[activePage]?.left || 0), top: d.y + (canvasOffsets[activePage]?.top || 0) })}
                      onResizeStop={(e, dir, ref, delta, pos) => updateBox(b.id, { left: pos.x + (canvasOffsets[activePage]?.left || 0), top: pos.y + (canvasOffsets[activePage]?.top || 0), width: ref.offsetWidth, height: ref.offsetHeight })}
                      style={{
                        pointerEvents: "auto",
                        border: isSelected ? "3px solid #ef4444" : "2px dashed #16a34a",
                        background: isSelected ? "rgba(255,240,240,0.95)" : "rgba(255,255,255,0.85)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        zIndex: 40,
                        boxSizing: "border-box",
                        borderRadius: 6,
                      }}
                    >
                      <div style={{ position: "absolute", left: 6, top: 6, zIndex: 60, pointerEvents: "auto" }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                          <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(b.id)} />
                          <span style={{ fontSize: 11 }}>{b.pageIndex}</span>
                        </label>
                      </div>

                      <div style={{ textAlign: "center", padding: 6, width: "100%" }}>
                        <div style={{ background: "#16a34a", color: "#fff", padding: "4px 8px", borderRadius: 4, display: "inline-block" }}>Signature</div>
                        <div style={{ fontSize: 11, color: "#334155", marginTop: 6 }}>{Math.round(b.width)}×{Math.round(b.height)} px</div>
                        <div style={{ marginTop: 8, display: "flex", gap: 6, justifyContent: "center" }}>
                          <button onClick={signSelected} disabled={loading} style={{ padding: "4px 8px" }}>{loading ? "Signing…" : "Sign selected"}</button>
                          <button onClick={() => removeBox(b.id)} style={{ padding: "4px 8px" }}>Delete</button>
                          <button onClick={() => { navigator.clipboard.writeText(JSON.stringify(exportCoords(b), null, 2)).then(() => alert("Coords copied")); }} style={{ padding: "4px 8px" }}>Export</button>
                        </div>
                      </div>
                    </Rnd>
                  );
                })}
              </div>
            </div>
          </Document>
        </div>

        {/* Pagination always visible below page area */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "8px 0", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <button onClick={() => setActivePage((p) => Math.max(1, p - 1))} disabled={activePage <= 1}>Prev</button>
          {renderPageNumbers()}
          <button onClick={() => setActivePage((p) => Math.min(numPages || p + 1, p + 1))} disabled={numPages ? activePage >= numPages : false}>Next</button>
          <div style={{ marginLeft: 12 }}>
            <label style={{ marginRight: 6 }}>Go to</label>
            <input
              type="number"
              min={1}
              max={numPages || 1}
              value={activePage}
              onChange={(e) => {
                const v = Number(e.target.value) || 1;
                if (v >= 1 && (numPages ? v <= numPages : true)) setActivePage(v);
              }}
              style={{ width: 64 }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
