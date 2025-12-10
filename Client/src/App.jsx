import React from 'react'
import PdfEditor from './components/PdfEditor'


export default function App(){
return (
<div className="app">
<PdfEditor pdfUrl={'/sample.pdf'} />
</div>
)
}