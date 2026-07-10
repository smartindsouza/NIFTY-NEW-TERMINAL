import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence, Reorder } from 'framer-motion';
import { Upload, Trash2, Plus, Download, FileText, Check, Settings2, Image as ImageIcon, Briefcase, RefreshCw, X, Type, Printer, Lock, Unlock, ExternalLink, ClipboardPaste, Save, Eye, EyeOff , ArrowUpRight, Hash, ArrowLeft, Receipt, Truck, Copy } from 'lucide-react';
import CustomDatePicker from '../components/ui/CustomDatePicker';
import CustomSelect from '../components/ui/CustomSelect';
import CustomCombobox from '../components/ui/CustomCombobox';
import { Search } from 'lucide-react';
import { parseExcel } from '../utils/excelParser';
import { compressImage } from '../utils/imageCompressor';
import { loadQuotesFromDB, saveQuotesToDB, clearQuotesFromDB, getAllQuotesFromDB } from '../utils/indexedDB';
import * as ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import html2canvas from 'html2canvas';

// Silent background backup triggered after saving quotes/invoices/POs/DNs
async function triggerSilentBackup() {
  try {
    const token = localStorage.getItem('artizio_google_access_token');
    if (!token) return; // No token, skip backup silently

    // Get backup folder
    const folderSearch = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=mimeType%3D'application%2Fvnd.google-apps.folder'+and+trashed%3Dfalse&fields=files(id,name)&pageSize=10`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const folderData = await folderSearch.json();
    let folderId = folderData.files?.find((f: any) => f.name === 'Artizio CRM Backups' || f.name?.includes('Artizio'))?.id;

    if (!folderId) {
      const createFolder = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Artizio CRM Backups', mimeType: 'application/vnd.google-apps.folder' })
      });
      const folder = await createFolder.json();
      folderId = folder.id;
    }
    if (!folderId) return;

    // Collect Firestore data via client SDK
    const { collection, getDocs } = await import('firebase/firestore');
    const { db } = await import('../lib/firebase');
    const COLS = ['projects','tasks','requirements','suppliers','designers','statuses','shippingAgents','shippingCharges','itemSelectors','appSettings'];
    const firestoreData: Record<string, any[]> = {};
    for (const col of COLS) {
      try {
        const snap = await getDocs(collection(db, col));
        firestoreData[col] = snap.docs.map(d => ({ _id: d.id, ...d.data() }));
      } catch { firestoreData[col] = []; }
    }
    const quotes = await getAllQuotesFromDB();
    const backup = { version: 2, timestamp: Date.now(), createdAt: new Date().toISOString(), firestoreData, quotes };
    const filename = `artizio-backup-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    const content = JSON.stringify(backup, null, 2);

    const metadata = { name: filename, mimeType: 'application/json', parents: [folderId] };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([content], { type: 'application/json' }));
    await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form
    });
    const now = new Date().toLocaleTimeString('en-AE', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit' });
    localStorage.setItem('artizio_last_backup', now);
    console.log('✅ Auto backup completed:', filename);
  } catch (e) {
    console.warn('Silent backup failed (non-critical):', e);
  }
}
import toast from 'react-hot-toast';
import { useFirestoreCollection, useFirestoreDocument } from '../hooks/useFirestore';
import { Supplier, Project, ListItem, LineItem } from '../types';

const ALL_FIELDS = [
  'Item Code',
  'Specification',
  'Remarks',
  'Image',
  'Material',
  'Size',
  'Unit Price USD',
  'Margin %',
  'Unit Price AED',
  'Qty',
  'Area',
  'Total'
];

const MAPPABLE_FIELDS = [
  ...ALL_FIELDS,
  'Sub Heading'
];

const headerAliases: Record<string, string[]> = {
  'Image': ['image', 'photo', 'picture', 'img', 'pic', 'thumbnail'],
  'Item Code': ["item code", "code", "sku", "ref", "model"],
  'Specification': ["specification", "spec", "technical details", "description", "desc", "details"],
  'Remarks': ["remarks", "notes", "comment"],
  'Material': ["material", "fabric", "finish", "wood"],
  'Size': ["size", "dimension", "dimensions", "measurements"],
  'Qty': ["qty", "quantity", "count", "nos", "pcs"],
  'Area': ["area", "sqft", "sqm", "coverage"],
  'Unit Price USD': ["unit price", "price", "cost", "amount", "supplier price", "supplier unit price", "price usd"],
  'Margin %': ["margin", "profit", "markup"],
  'Unit Price AED': ["rate", "price/sqft", "price/sqm", "selling price", "unit price aed", "rate per sqm", "rate per sqft"],
  'Total': ["total", "amount"]
};

interface MappedData {
  id: string;
  isSubHeading?: boolean;
  subHeadingText?: string;
  image?: string;
  'Item Code': string;
  'Specification': string;
  'Material': string;
  'Size': string;
  'Qty': string;
  'Area': string;
  'Unit Price USD': string;
  'Unit Price AED': string;
  'Margin %': string;
  'Total': string;
  [key: string]: any;
}

const AutoResizeTextarea = ({ value, onChange, placeholder, className, readOnly, onBlur }: any) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [isEditing, setIsEditing] = useState(false);

  const resize = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const scrollHeight = textareaRef.current.scrollHeight;
      // Set a minimum height of 32px to ensure it's not too small when empty
      textareaRef.current.style.height = `${Math.max(32, scrollHeight)}px`;
    }
  };

  useEffect(() => {
    if (isEditing) {
      resize();
      textareaRef.current?.focus();
    }
  }, [isEditing, value]);

  useEffect(() => {
    if (!textareaRef.current || !isEditing) return;
    
    // Resize when the element's own dimensions change (e.g. from column resize)
    const resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(() => {
        resize();
      });
    });
    
    resizeObserver.observe(textareaRef.current);
    
    return () => resizeObserver.disconnect();
  }, [isEditing]);

  const hasMultipleLines = typeof value === 'string' && value.includes('\n');

  if (!isEditing) {
    const isCentered = className && className.includes('text-center');
    const displayValue = String(value || '');
    
    if (!displayValue) {
      return (
        <div 
          onClick={() => !readOnly && setIsEditing(true)}
          className={`${className} ${readOnly ? '' : 'cursor-pointer'} min-h-[32px] py-1.5 px-2 text-slate-600 italic select-none w-full ${isCentered ? 'text-center' : 'text-left'}`}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {placeholder || 'Enter text'}
        </div>
      );
    }

    if (hasMultipleLines) {
      const parts = displayValue.split('\n');
      return (
        <div 
          onClick={() => !readOnly && setIsEditing(true)}
          className={`${className} ${readOnly ? '' : 'cursor-pointer'} min-h-[32px] py-1.5 px-2 flex flex-col gap-0.5 w-full whitespace-pre-wrap break-words ${isCentered ? 'text-center' : 'text-left'}`}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className="text-slate-300 font-medium">{parts[0]}</span>
          {parts.slice(1).map((part, idx) => (
            <span key={idx} className={`text-slate-500 italic pl-3 text-xs block ${isCentered ? 'text-center' : 'text-left'}`}>
              {part}
            </span>
          ))}
        </div>
      );
    }

    // Single line text (needs to wrap automatically and show the entire text)
    return (
      <div 
        onClick={() => !readOnly && setIsEditing(true)}
        className={`${className} ${readOnly ? '' : 'cursor-pointer'} min-h-[32px] py-1.5 px-2 w-full whitespace-pre-wrap break-words ${isCentered ? 'text-center' : 'text-left'}`}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span>{displayValue}</span>
      </div>
    );
  }

  return (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={onChange}
      onBlur={(e) => {
        setIsEditing(false);
        if (onBlur) onBlur(e);
      }}
      placeholder={placeholder}
      readOnly={readOnly}
      className={`${className} resize-none overflow-hidden`}
      rows={1}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
};

const SQFT_CONVERSION = 10.7639;

const getQtyAreaFactor = (row: any, isCarpet: boolean): number => {
  if (!row) return 0;
  
  const pQty = parseFloat(String(row['Qty'] || '').replace(/[^0-9.-]/g, ''));
  const qty = isNaN(pQty) ? 1 : pQty;
  
  if (!isCarpet) {
    return qty;
  }
  
  const pArea = parseFloat(String(row['Area'] || '').replace(/[^0-9.-]/g, ''));
  const area = isNaN(pArea) ? 0 : pArea;
  
  if (area > 0) {
    return qty * area;
  }
  
  return qty;
};

const getNextSerialNumber = (quoteNumber: string): string => {
  if (!quoteNumber) return '01';
  
  // Try to match ending with -XX or other number sequence, e.g. "OS-210526-01" or "OS-210526-9"
  const match = quoteNumber.match(/(.*-)(\d+)$/);
  if (match) {
    const prefix = match[1];
    const numStr = match[2];
    const nextNum = parseInt(numStr, 10) + 1;
    const paddedNextNum = String(nextNum).padStart(numStr.length, '0');
    return `${prefix}${paddedNextNum}`;
  }
  
  // Also try to match trailing numbers without hyphens, like "INV101"
  const trailingNumMatch = quoteNumber.match(/(.*?)(\d+)$/);
  if (trailingNumMatch) {
    const prefix = trailingNumMatch[1];
    const numStr = trailingNumMatch[2];
    const nextNum = parseInt(numStr, 10) + 1;
    const paddedNextNum = String(nextNum).padStart(numStr.length, '0');
    return `${prefix}${paddedNextNum}`;
  }
  
  // Default fallback if there's no number at the end
  return `${quoteNumber}-02`;
};

const capitalizeFields = (str: string): string => {
  if (!str) return '';
  return str.replace(/(?:^|[^a-zA-Z0-9])([a-z])/g, (match) => match.toUpperCase());
};

export default function Quotes({ onNavigate }: { onNavigate?: (tab: string) => void }) {
  const { data: suppliers } = useFirestoreCollection<Supplier>('suppliers');
  const { data: requirements } = useFirestoreCollection<ListItem>('requirements');
  const { data: projects, add: addProject, update: updateProject } = useFirestoreCollection<Project>('projects', 'order');
  const { data: logoSetting } = useFirestoreDocument<{ value: string }>('appSettings', 'reportLogo');
  const reportLogo = logoSetting?.value || null;

  const { data: companyInfoDoc } = useFirestoreDocument<any>('appSettings', 'companyInfo');
  const { data: bankDetailsDoc } = useFirestoreDocument<any>('appSettings', 'bankDetails');
  const bankDetails = bankDetailsDoc || {
    bankName: 'ADCB',
    accountName: 'PERFECT CREATIONS INTERIORS LLC',
    accountNumber: '10614913820002',
    iban: 'AE250030010614913820002',
    swift: 'EBILAEAD'
  };
  const companyInfo = companyInfoDoc || { 
    name: 'Artizio Bespoke Furniture', 
    phone: '', 
    email: '', 
    website: '', 
    trn: '', 
    address: '' 
  };

  
  const [extractedData, setExtractedData] = useState<any[]>(() => {
    try { const saved = localStorage.getItem('artizio_extracted_data'); return saved ? JSON.parse(saved) : []; } catch { return []; }
  });
  const [headers, setHeaders] = useState<string[]>(() => {
    try { const saved = localStorage.getItem('artizio_headers'); return saved ? JSON.parse(saved) : []; } catch { return []; }
  });
  const [mapping, setMapping] = useState<Record<string, string>>(() => {
    try { const saved = localStorage.getItem('artizio_quote_mapping'); return saved ? JSON.parse(saved) : {}; } catch { return {}; }
  });
  const [mappedData, setMappedData] = useState<MappedData[]>([]);
  const [roundedColumns, setRoundedColumns] = useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem('artizio_rounded_columns');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed['Unit Price AED'] === undefined) {
          parsed['Unit Price AED'] = true;
        }
        return parsed;
      }
      return { 'Unit Price AED': true };
    } catch {
      return { 'Unit Price AED': true };
    }
  });
  const [showPreview, setShowPreview] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    try {
      const saved = localStorage.getItem('quote_col_widths');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });
  const [columnsLocked, setColumnsLocked] = useState(() => {
    return localStorage.getItem('quote_cols_locked') === 'true';
  });
  const [roundRateAED, setRoundRateAED] = useState(false);

  useEffect(() => {
    if (Object.keys(colWidths).length > 0) {
      try { localStorage.setItem('quote_col_widths', JSON.stringify(colWidths)); } catch (e) {}
    }
  }, [colWidths]);

  // Re-calculate rates when rounding setting changes
  useEffect(() => {
    if (!isCarpetOrLinen) return;
    
    setMappedData(prev => 
      prev.map(row => {
        if (row.isSubHeading) return row;
        
        const header = supplierQuoteHeaders.find(h => h.id === row.sourceId) || supplierQuoteHeaders[0];
        const unitPrice = parseFloat(String(row['Unit Price USD']).replace(/[^0-9.]/g, '')) || 0;
        const margin = parseFloat(String(row['Margin %']).replace(/[^0-9.-]/g, '')) || 0;
        const exchangeRate = parseFloat(header?.exchangeRate || '1');
        const effectiveExchangeRate = exchangeRate === 0 ? 1 : (exchangeRate || 1);
        
        let rate = unitPrice * effectiveExchangeRate * (1 + margin / 100);
        rate = Number(rate.toFixed(2));
        if (roundRateAED) {
          rate = Math.ceil(rate);
        }
        
        const newRow = { ...row, ['Unit Price AED']: String(rate) };
        const qtyOrArea = parseFloat(String(newRow['Area']).replace(/[^0-9.]/g, '')) || 0;
        if (quoteDetails.isPO) {
          newRow['Total'] = (unitPrice * qtyOrArea).toFixed(2);
        } else {
          newRow['Total'] = (rate * qtyOrArea).toFixed(2);
        }
        
        return newRow;
      })
    );
  }, [roundRateAED]);

  useEffect(() => {
    localStorage.setItem('quote_cols_locked', String(columnsLocked));
  }, [columnsLocked]);
  
  const startResizing = (field: string, e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.pageX;
    const th = (e.target as HTMLElement).closest('th');
    const startWidth = th ? th.clientWidth : (colWidths[field] || 150);

    const onMouseMove = (moveEvent: MouseEvent) => {
      const newWidth = Math.max(50, startWidth + (moveEvent.pageX - startX));
      setColWidths(prev => ({ ...prev, [field]: newWidth }));
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  const [isMappingModalOpen, setIsMappingModalOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  
  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
  const [saveMode, setSaveMode] = useState<'new' | 'existing'>('new');
  const [selectedSaveProjectId, setSelectedSaveProjectId] = useState('');
  const [newSaveProjectName, setNewSaveProjectName] = useState('');
  const [showSerialPrompt, setShowSerialPrompt] = useState(false);
  const [pendingSaveParams, setPendingSaveParams] = useState<{ opProjectId?: string } | null>(null);

  const [clientInfo, setClientInfo] = useState(() => {
    try {
      const saved = localStorage.getItem('artizio_client_info');
      if (saved) {
         const parsed = JSON.parse(saved);
         if (parsed.sameAsBilling === undefined) parsed.sameAsBilling = true;
         return parsed;
      }
    } catch {}
    return {
      name: '',
      email: '',
      billingAddress: '',
      sameAsBilling: true,
      deliveryAddress: '',
      sameAsDelivery: false
    };
  });

  const [quoteDetails, setQuoteDetails] = useState(() => {
    try {
      const saved = localStorage.getItem('artizio_quote_details');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (!parsed.leadTime) parsed.leadTime = '90 Days';
        return parsed;
      }
    } catch {}
    return {
      quotationNumber: '',
      quotationDate: new Date().toISOString().slice(0, 10),
      referenceProject: '',
      category: '',
      leadTime: '90 Days'
    };
  });
  
  const manualQuoteRef = useRef(false);

  useEffect(() => {
    if (!clientInfo.name) {
      setQuoteDetails(prev => ({ ...prev, quotationNumber: '' }));
      return;
    }
    if (clientInfo.name && !manualQuoteRef.current) {
      const nameParts = clientInfo.name.trim().split(' ');
      const firstName = nameParts[0].toUpperCase();
      if (firstName.length >= 1) {
        const firstLetter = firstName.charAt(0);
        const lastLetter = firstName.length > 1 ? firstName.charAt(firstName.length - 1) : firstLetter;
        const initials = `${firstLetter}${lastLetter}`;
        
        const d = new Date(); // Use current date
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const yy = String(d.getFullYear()).slice(-2);
        
        const generated = `${initials}-${dd}${mm}${yy}-01`;
        
        setQuoteDetails(prev => ({
          ...prev,
          quotationNumber: generated
        }));
      }
    }
  }, [clientInfo.name]);

  const { data: quoteDefaultsDoc } = useFirestoreDocument<any>('appSettings', 'quoteDefaults');
  const defaultQuoteTerms = '1. Delivery: Ex Stock items 3-7 days, Custom made items 45-60 working days, Pre Order import Items 90 working Days.\n2. Payment terms: 50% advance, 50% before delivery.\n3. Ex Stock items subject to prior sale.\n4. All goods remain the property of Artizio until full payment is received.\n5. Custom Made / Pre Order items once ordered cannot be cancelled.\n6. The above mentioned prices are inclusive of delivery within Dubai.\n7. Any claims or disputes must be raised within 7 days of delivery.\n8. This Quote is valid for 15 days from the date mentioned in the Quote.';
  const defaultPurchaseOrderTerms = '1. Payment: 50% Advance before production, 50% Before Shipment.\n2. Payment in USD for International & AED for Local Suppliers.\n3. Terms: Ex Works';
  const defaultInvoiceTerms = '1. Artizio is not responsible for delays or issues caused by site access restrictions or third-party handling.\n2. Colors, textures, finishes, and dimensions may vary slightly due to natural materials, lighting, and craftsmanship. Such variations are not considered defects.\n3. Returns or exchanges are accepted only for manufacturing defects reported within 48 hours of delivery.\n4. Custom-made, discounted, and clearance items are non-refundable.\n5. Order cancellations may incur a cancellation fee.\n6. All transactions are governed by the laws of the UAE and the Emirate of Dubai.';
  const defaultDeliveryOrderTerms = '1. Customer confirms that all items were received in good condition unless otherwise stated on this delivery note at the time of delivery.\n2. Returns or exchanges are accepted only for manufacturing defects reported within 48 hours of delivery.\n3. Once the delivery note is signed, the company shall not be held responsible for any physical damage, missing items, or claims not mentioned at delivery.\n4. Delivery times are estimates only. The company is not liable for delays caused by traffic, weather, building access restrictions, or unforeseen circumstances.\n5. The customer is responsible for ensuring adequate access, lift availability, and safe entry for delivery and installation.';
  
  const quoteDefaults = quoteDefaultsDoc || {
    defaultVat: '5',
    quotationTerms: defaultQuoteTerms,
    purchaseOrderTerms: defaultPurchaseOrderTerms,
    invoiceTerms: defaultInvoiceTerms,
    deliveryOrderTerms: defaultDeliveryOrderTerms
  };

  const [pricingSettings, setPricingSettings] = useState(() => {
    let parsed = null;
    let isEditingQuote = false;
    try {
      const quoteId = localStorage.getItem('artizio_quote_id');
      if (quoteId) {
        isEditingQuote = true;
      }
      
      const saved = localStorage.getItem('artizio_pricing');
      if (saved) {
        parsed = JSON.parse(saved);
      }
    } catch {}

    if (isEditingQuote && parsed) {
      return {
        discountType: parsed.discountType || '%',
        discountValue: parsed.discountValue || 0,
        shipping: parsed.shipping || 0,
        roundUpTo50: parsed.roundUpTo50 ?? true,
        roundGrandTotal: parsed.roundGrandTotal || false,
        vatEnabled: parsed.vatEnabled ?? true, // VAT on by default; persists per quote
      };
    }

    return {
      discountType: parsed?.discountType || '%',
      discountValue: 0, // Always empty on new quote intent
      shipping: 0, // Always empty on new quote intent
      roundUpTo50: true, // Adjusted Unit Price AED enabled by default on every new quote
      roundGrandTotal: parsed?.roundGrandTotal || false,
      vatEnabled: true, // VAT enabled by default on every new quote
    };
  });
  
  const [quoteNotes, setQuoteNotes] = useState(''); // Always empty on new quote intent
  
  // Returns the correct DEFAULT terms for a given document type, from Settings (quoteDefaults).
  const getDefaultTermsForType = (): string => {
    if (quoteDetails.isPO) return quoteDefaults?.purchaseOrderTerms ?? '';
    if (quoteDetails.isInvoice) return quoteDefaults?.invoiceTerms ?? '';
    if (quoteDetails.isDO) return quoteDefaults?.deliveryOrderTerms ?? '';
    return quoteDefaults?.quotationTerms ?? defaultQuoteTerms;
  };

  // `quoteTermsOverride` is ONLY set when the user manually edits the terms for this specific
  // document (typing in the textarea), or when reopening a document that had genuinely custom
  // terms saved. When it's null, the terms shown/saved are ALWAYS the current document type's
  // default — so an Invoice always shows Invoice terms, a PO always shows PO terms, etc.,
  // regardless of what type it was converted from.
  const [quoteTermsOverride, setQuoteTermsOverride] = useState<string | null>(() => {
    try {
      if (localStorage.getItem('artizio_quote_has_own_terms') === '1') {
        const saved = localStorage.getItem('artizio_quote_terms');
        if (saved !== null) return saved;
      }
    } catch {}
    return null;
  });

  // The effective terms: the user's override if present, otherwise the type default.
  const quoteTerms = quoteTermsOverride !== null ? quoteTermsOverride : getDefaultTermsForType();
  const setQuoteTerms = (val: string) => setQuoteTermsOverride(val);

  // Legacy-data guard: older Invoice/PO/DN documents were saved with the QUOTATION terms
  // wrongly carried over. If the loaded override exactly matches the quotation default but
  // this is NOT a quote, the override is bogus — drop it so the correct type default shows.
  const legacyTermsChecked = useRef(false);
  useEffect(() => {
    if (legacyTermsChecked.current) return;
    if (quoteDefaultsDoc === undefined) return; // wait for Settings to load
    legacyTermsChecked.current = true;
    if (quoteTermsOverride === null) return;
    const isNonQuote = quoteDetails.isPO || quoteDetails.isInvoice || quoteDetails.isDO;
    const quotationDefault = String(quoteDefaults?.quotationTerms ?? defaultQuoteTerms).trim();
    if (isNonQuote && quoteTermsOverride.trim() === quotationDefault) {
      setQuoteTermsOverride(null); // bogus carried-over quotation terms → use type default
    }
  }, [quoteDefaultsDoc]);

  const [supplierQuoteHeaders, setSupplierQuoteHeaders] = useState(() => {
    try {
      const saved = localStorage.getItem('artizio_supplier_quote_headers');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [{
      id: `sq-${Date.now()}`,
      supplier: '',
      currency: 'USD',
      exchangeRate: '3.70',
      margin: '120'
    }];
  });
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);

  const [areaUnit, setAreaUnit] = useState<'Sqft' | 'Sqm'>('Sqft');

  useEffect(() => {
    // Only fetch for the first header if it hasn't been fetched yet
    if (supplierQuoteHeaders.length > 0 && supplierQuoteHeaders[0].currency === 'USD' && supplierQuoteHeaders[0].exchangeRate === '3.70') {
      fetchExchangeRate(supplierQuoteHeaders[0].id, 'USD', true);
    }
  }, []);

  const capitalizeWords = (str: string) => {
    if (!str) return str;
    return str.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  };

  const uniqueClientNames = Array.from(new Set((projects || []).map(p => p.clientName).filter(Boolean))) as string[];
  const uniqueProjectNames = Array.from(new Set(
    (projects || [])
      .filter(p => !clientInfo.name || String(p.clientName || '').toLowerCase() === String(clientInfo.name || '').toLowerCase())
      .map(p => p.name)
      .filter(Boolean)
  )) as string[];

  const isCarpetOrLinen = (quoteDetails.category || '').toLowerCase().includes('carpet') || (quoteDetails.category || '').toLowerCase().includes('linen');
  const displayCurrency = supplierQuoteHeaders.some(h => h.currency === 'AED') ? 'AED' : 'USD';

  let currentStandardFields = isCarpetOrLinen ? [
    'Item Code',
    'Specification',
    'Remarks',
    'Image',
    'Material',
    'Size',
    'Qty',
    'Area',
    'Margin %',
    'Unit Price USD',
    'Unit Price AED',
    'Total'
  ] : [
    'Item Code',
    'Specification',
    'Remarks',
    'Image',
    'Material',
    'Size',
    'Qty',
    'Unit Price USD',
    'Margin %',
    'Unit Price AED',
    'Total'
  ];

  if (quoteDetails.isPO) {
    currentStandardFields = currentStandardFields.filter(f => f !== 'Margin %' && f !== 'Unit Price AED');
  } else if (quoteDetails.isDO) {
    currentStandardFields = isCarpetOrLinen ? [
      'Item Code',
      'Specification',
      'Remarks',
      'Image',
      'Material',
      'Qty',
      'Area'
    ] : [
      'Item Code',
      'Specification',
      'Remarks',
      'Image',
      'Material',
      'Qty'
    ];
  }

  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [dataLoaded, setDataLoaded] = useState(false);
  const [highlightRowId, setHighlightRowId] = useState<string | null>(null);

  // Load saved mapping on mount
  useEffect(() => {
    const loadData = async () => {
      const savedMappedData = await loadQuotesFromDB();
      if (savedMappedData && Array.isArray(savedMappedData) && savedMappedData.length > 0) {
        setMappedData(savedMappedData);
      }
      setDataLoaded(true);
    };
    
    loadData();
  }, []);

  // Save mappedData on change
  useEffect(() => {
    if (mappedData.length > 0) {
      saveQuotesToDB(mappedData);
    }
  }, [mappedData]);

  // Save form states
  useEffect(() => {
    try { localStorage.setItem('artizio_extracted_data', JSON.stringify(extractedData)); } catch (e) { console.warn('Storage limit exceeded for extractedData'); }
  }, [extractedData]);

  useEffect(() => {
    try { localStorage.setItem('artizio_headers', JSON.stringify(headers)); } catch (e) {}
  }, [headers]);

  useEffect(() => {
    try { localStorage.setItem('artizio_pricing', JSON.stringify(pricingSettings)); } catch (e) {}
  }, [pricingSettings]);

  useEffect(() => {
    try { localStorage.setItem('artizio_quote_notes', quoteNotes); } catch (e) {}
  }, [quoteNotes]);

  useEffect(() => {
    try {
      if (quoteTermsOverride !== null) {
        localStorage.setItem('artizio_quote_terms', quoteTermsOverride);
        localStorage.setItem('artizio_quote_has_own_terms', '1');
      } else {
        localStorage.removeItem('artizio_quote_terms');
        localStorage.removeItem('artizio_quote_has_own_terms');
      }
    } catch (e) {}
  }, [quoteTermsOverride]);

  useEffect(() => {
    try { localStorage.setItem('artizio_client_info', JSON.stringify(clientInfo)); } catch (e) {}
  }, [clientInfo]);

  useEffect(() => {
    try { localStorage.setItem('artizio_quote_details', JSON.stringify(quoteDetails)); } catch (e) {}
  }, [quoteDetails]);

  useEffect(() => {
    try { localStorage.setItem('artizio_supplier_quote_headers', JSON.stringify(supplierQuoteHeaders)); } catch (e) {}
  }, [supplierQuoteHeaders]);

  useEffect(() => {
    try { localStorage.setItem('artizio_rounded_columns', JSON.stringify(roundedColumns)); } catch (e) {}
  }, [roundedColumns]);

  // Recalculate rates when exchange rate or margin changes in headers
  useEffect(() => {
    if (mappedData.length > 0) {
      setMappedData(prev => {
        let changed = false;
        const newData = prev.map(row => {
          if (row.isSubHeading) return row;
          
          const header = supplierQuoteHeaders.find(h => h.id === row.sourceId) || supplierQuoteHeaders[0];
          const unitPrice = parseFloat(String(row['Unit Price USD']).replace(/[^0-9.]/g, '')) || 0;
          const exchangeRate = parseFloat(header?.exchangeRate || '1');
          const effectiveExchangeRate = exchangeRate === 0 ? 1 : (exchangeRate || 1);
          const currentMargin = parseFloat(String(row['Margin %']).replace(/[^0-9.-]/g, '')) || 0;
          // Rows whose margin was set individually keep their own margin; everything else
          // follows the supplier header's overall margin.
          const headerMargin = row.marginCustom ? currentMargin : parseFloat(header?.margin || '120');

          let rate = unitPrice * effectiveExchangeRate * (1 + headerMargin / 100);
          if (!isCarpetOrLinen) {
            rate = Math.round(rate);
            if (pricingSettings.roundUpTo50) {
              rate = Math.ceil(rate / 100) * 100;
            }
          } else {
            rate = Number(rate.toFixed(2));
          }
          
          const qtyOrArea = getQtyAreaFactor(row, isCarpetOrLinen);
          const totalVal = isCarpetOrLinen ? Number((rate * qtyOrArea).toFixed(2)) : Math.round(rate * qtyOrArea);
          const total = quoteDetails.isPO ? Number((unitPrice * qtyOrArea).toFixed(2)) : totalVal;
          
          const newRateStr = String(rate);
          const newTotalStr = String(total);
          const newMarginStr = String(headerMargin);

          const needsUpdate = quoteDetails.isPO
            ? (row['Total'] !== newTotalStr)
            : (row['Unit Price AED'] !== newRateStr || row['Total'] !== newTotalStr || row['Margin %'] !== newMarginStr);

          if (needsUpdate) {
            changed = true;
            if (quoteDetails.isPO) {
              return {
                 ...row,
                 'Total': newTotalStr
              };
            }
            return {
              ...row,
              'Margin %': newMarginStr,
              'Unit Price AED': newRateStr,
              'Total': newTotalStr
            };
          }
          return row;
        });
        return changed ? newData : prev;
      });
    }
  }, [supplierQuoteHeaders, isCarpetOrLinen, pricingSettings.roundUpTo50, quoteDetails.isPO, dataLoaded]);

  // When opened from the Catalog, scroll to and briefly highlight the exact item row.
  useEffect(() => {
    if (!dataLoaded || mappedData.length === 0) return;
    const targetId = localStorage.getItem('artizio_highlight_row_id');
    if (!targetId) return;
    if (!mappedData.some(r => r.id === targetId)) return; // not in this quote
    localStorage.removeItem('artizio_highlight_row_id');
    setHighlightRowId(targetId);
    // Wait for the row to render, then scroll it into view.
    setTimeout(() => {
      const el = document.getElementById(`quote-row-${targetId}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 400);
    // Remove the highlight after a few seconds.
    const t = setTimeout(() => setHighlightRowId(null), 4000);
    return () => clearTimeout(t);
  }, [dataLoaded, mappedData]);

  const addSupplierQuoteHeader = () => {
    const newId = `sq-${Date.now()}`;
    setSupplierQuoteHeaders(prev => [
      ...prev,
      {
        id: newId,
        supplier: '',
        currency: 'USD',
        exchangeRate: '3.70',
        margin: '120'
      }
    ]);
    fetchExchangeRate(newId, 'USD', true);
  };

  const fetchExchangeRate = async (id: string, currency: string, addMarkup: boolean = true) => {
    if (currency === 'AED') return;
    try {
      const response = await fetch(`https://open.er-api.com/v6/latest/${currency}`);
      const data = await response.json();
      if (data && data.rates && data.rates.AED) {
         const rate = data.rates.AED;
         const finalRate = addMarkup ? (rate + 0.03).toFixed(2) : rate.toFixed(2);
         setSupplierQuoteHeaders(prev =>
           prev.map(header => {
             if (header.id !== id) return header;
             return { ...header, exchangeRate: finalRate };
           })
         );
      }
    } catch (error) {
      console.error("Failed to fetch exchange rate", error);
    }
  };

  const updateSupplierQuoteHeader = (id: string, field: string, value: string) => {
    if (field === 'currency') {
      if (value === 'USD') {
        fetchExchangeRate(id, 'USD', true);
      }
    }
    setSupplierQuoteHeaders(prev =>
      prev.map(header => {
        if (header.id !== id) return header;
        const newHeader = { ...header, [field]: value };
        if (field === 'currency' && value === 'AED') {
          newHeader.exchangeRate = '0';
        }
        return newHeader;
      })
    );
  };

  const handleSupplierChange = (id: string, selectedSupplierName: string) => {
    const supplier = (suppliers || []).find(s => s.name === selectedSupplierName);
    
    setSupplierQuoteHeaders(prev =>
      prev.map(header => {
        if (header.id !== id) return header;
        
        const oldSupplier = (suppliers || []).find(s => s.name === header.supplier);
        const oldPrefix = oldSupplier?.code ? `${oldSupplier.code}-` : '';
        const newPrefix = supplier?.code ? `${supplier.code}-` : '';

        // Update mappedData accordingly
        if (mappedData.length > 0) {
          setMappedData(prevData => prevData.map(row => {
            if (row.isSubHeading || row.sourceId !== id || !row['Item Code']) return row;
            
            let currentCode = row['Item Code'];
            if (oldPrefix && currentCode.startsWith(oldPrefix)) {
              currentCode = currentCode.slice(oldPrefix.length);
            }
            if (newPrefix && !currentCode.startsWith(newPrefix)) {
              currentCode = newPrefix + currentCode;
            }
            
            return { ...row, 'Item Code': currentCode };
          }));
        }

        const newCurrency = supplier?.currency || header.currency;
        const newExchangeRate = newCurrency === 'AED' ? '0' : header.exchangeRate;

        return {
          ...header,
          supplier: selectedSupplierName,
          currency: newCurrency,
          exchangeRate: newExchangeRate
        };
      })
    );
    
    if (supplier?.category) {
      setQuoteDetails(prev => ({ ...prev, category: supplier.category, leadTime: supplier.leadTime || '90 Days' }));
    } else {
      setQuoteDetails(prev => ({ ...prev, category: '', leadTime: supplier?.leadTime || '90 Days' }));
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setIsUploading(true);
    try {
      const { headers, data } = await parseExcel(file);
      setHeaders(headers);
      setExtractedData(data);
      
      // Auto-suggest mapping
      const newMapping = { ...mapping };
      let updated = false;
      
      headers.forEach(header => {
        const strHeader = String(header || "");
        const lowerHeader = strHeader.toLowerCase().trim();

        // Always auto-ignore any "total"/"grand total"/"sub total"/"amount" summary columns —
        // these are computed by the system, not imported. Force this even if a previous/saved
        // mapping had assigned them to a field.
        if (/\b(grand\s*total|sub\s*total|subtotal|total)\b/.test(lowerHeader)) {
          if (newMapping[header] !== '') {
            newMapping[header] = ''; // ignored
            updated = true;
          }
          return;
        }

        // If not already mapped or mapped to empty
        if (!newMapping[header]) {
          for (const [stanField, aliases] of Object.entries(headerAliases)) {
            if (aliases.some(alias => lowerHeader.includes(alias))) {
              newMapping[header] = stanField;
              updated = true;
              break;
            }
          }
        }
      });
      
      if (updated || Object.keys(newMapping).length === 0) {
        setMapping(newMapping);
      }
      
      setIsMappingModalOpen(true);
    } catch (err) {
      console.error("Failed to parse excel", err);
      toast.error("Failed to read the Excel file. Please ensure it is a valid format.");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const applyMapping = () => {
    // Save to local storage
    try { localStorage.setItem('artizio_quote_mapping', JSON.stringify(mapping)); } catch(e) {}
    
    // Process data
    const headerSettings = supplierQuoteHeaders.find(h => h.id === activeSourceId) || supplierQuoteHeaders[0];
    const selectedSupplier = (suppliers || []).find(s => s.name === headerSettings.supplier);
    const supplierPrefix = selectedSupplier?.code ? `${selectedSupplier.code}-` : '';

    let lastSubHeadingText = '';
    
    let maxSerial = 0;
    mappedData.forEach(row => {
      if (!row.isSubHeading && row['Item Code']) {
        const code = String(row['Item Code']);
        if (supplierPrefix && code.startsWith(supplierPrefix)) {
          const remainder = code.slice(supplierPrefix.length);
          if (/^\d+$/.test(remainder)) {
            maxSerial = Math.max(maxSerial, parseInt(remainder, 10));
          }
        } else if (!supplierPrefix) {
          if (/^\d+$/.test(code)) {
            maxSerial = Math.max(maxSerial, parseInt(code, 10));
          }
        }
      }
    });
    let autoSerial = maxSerial + 1;

    // Safety net: truncate at the first totals/summary row that may have slipped past the
    // parser. Uses the same "dominant total label in a short cell" rule to avoid matching
    // product descriptions that merely contain the word "total".
    const totalRowIdx = extractedData.findIndex(row =>
      Object.keys(row).some(key => {
        if (key === 'image' || key === '_originalRow') return false;
        const v = row[key];
        if (v === null || v === undefined) return false;
        const t = String(v).toLowerCase().trim();
        if (t === '' || t.length > 22) return false;
        return /^(grand\s*total|sub\s*total|subtotal|total)\b[\s:.\-]*(amount|amt|price|value|cost|usd|aed|qty|quantity)?[\s:.\-]*$/.test(t);
      })
    );
    const rowsToProcess = totalRowIdx >= 0 ? extractedData.slice(0, totalRowIdx) : extractedData;

    const finalData: MappedData[] = rowsToProcess.flatMap((row, index) => {
      const newRow: any = { id: `item-${Date.now()}-${index}`, image: row.image, sourceId: activeSourceId };
      
      const keysWithData = Object.keys(row).filter(key => key !== 'image' && key !== '_originalRow' && row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '');
      const uniqueVals = new Set(keysWithData.map(key => String(row[key]).trim()));

      if (uniqueVals.size === 1 && !row.image) {
        newRow.isSubHeading = true;
        newRow.subHeadingText = Array.from(uniqueVals)[0];
        lastSubHeadingText = newRow.subHeadingText;
        return [newRow as MappedData];
      }

      // Set default empty values for standard fields
      ALL_FIELDS.forEach(field => {
        newRow[field] = '';
      });
      
      let mappedSubHeading: string | null = null;

      // Apply mapped headers
      Object.keys(row).forEach(header => {
        const standardField = mapping[header];
        if (standardField) {
          const val = row[header];
          if (standardField === 'Sub Heading') {
            if (val !== undefined && val !== null && String(val).trim() !== '') {
               if (mappedSubHeading) {
                 mappedSubHeading += ', ' + String(val);
               } else {
                 mappedSubHeading = String(val);
               }
            }
          } else if (standardField === 'Image') {
             // Use mapping for image if not previously extracted natively
             if (!newRow.image && val) {
                const strVal = String(val);
                if (strVal.startsWith('http') || strVal.startsWith('data:image')) {
                  newRow.image = strVal;
                }
             }
          } else if (['Unit Price USD', 'Unit Price AED', 'Area', 'Qty', 'Margin %'].includes(standardField)) {
            if (val !== undefined && val !== null && String(val).trim() !== '') {
              // Extract first valid number from string (e.g. "AED 1,234.56" -> 1234.56)
              const match = String(val).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
              if (match) {
                if (standardField === 'Unit Price USD') {
                  const numVal = parseFloat(match[0]);
                  newRow[standardField] = isNaN(numVal) ? match[0] : numVal.toFixed(2);
                } else {
                  newRow[standardField] = match[0];
                }
              } else {
                newRow[standardField] = String(val);
              }
            } else {
              if (!newRow[standardField]) {
                newRow[standardField] = '';
              }
            }
          } else {
             if (val !== undefined && val !== null && String(val).trim() !== '') {
               const str = String(val);
               // Convert to title case: small case with first letter of each word in capitals
               let titleCaseStr = str;
               if (!['Image', 'Item Code', 'Qty', 'Unit Price USD', 'Unit Price AED', 'Area', 'Margin %', 'Total'].includes(standardField)) {
                 titleCaseStr = str.replace(
                   /\w\S*/g,
                   text => text.charAt(0).toUpperCase() + text.substring(1).toLowerCase()
                 );
               }
               
               // When multiple columns map to the same field, join their values with a
               // newline. (Previously the original column header title was prefixed before
               // each value — that has been disabled per request.)
               if (newRow[standardField]) {
                 newRow[standardField] += '\n' + titleCaseStr;
               } else {
                 newRow[standardField] = titleCaseStr;
               }
             }
          }
        }
      });
      
      if (!newRow['Margin %']) {
        newRow['Margin %'] = headerSettings.margin || '120';
      }

      if (!newRow['Qty'] || String(newRow['Qty']).trim() === '') {
        newRow['Qty'] = '1';
      }

      // Clean up Item Code: strip leading labels like "Model:", "SKU:", "Code:", "Ref:",
      // "Item Code:", and serial-number labels like "NO.:", "No.", "S.No", "Sr. No", "Serial".
      // The label must be followed by a separator (: . -) or a space-then-digit, so genuine
      // codes that merely start with these letters (e.g. "NORDIC-100", "MODELX5") are untouched.
      if (newRow['Item Code']) {
        newRow['Item Code'] = String(newRow['Item Code'])
          .replace(/^\s*(model|sku|code|ref|item\s*code|s[\.\s]*r?[\.\s]*no|sr[\.\s]*no|serial(\s*no)?|no)\s*([\.\:\-]+\s*|\s+(?=\d))/i, '')
          .trim();
      }

      // Add supplier prefix to Item Code
      if (!newRow['Item Code'] || String(newRow['Item Code']).trim() === '') {
        const formattedSerial = String(autoSerial).padStart(3, '0');
        newRow['Item Code'] = supplierPrefix ? supplierPrefix + formattedSerial : formattedSerial;
        autoSerial++;
      } else if (supplierPrefix && newRow['Item Code'] && !newRow['Item Code'].startsWith(supplierPrefix)) {
        newRow['Item Code'] = supplierPrefix + newRow['Item Code'];
      }

      // Calculate initial Rate and Total
      const initialPriceAED = parseFloat(String(newRow['Unit Price AED'] || '0').replace(/[^0-9.]/g, '')) || 0;
      const initialPriceUSD = parseFloat(String(newRow['Unit Price USD'] || '0').replace(/[^0-9.]/g, '')) || 0;
      const initialMargin = parseFloat(String(newRow['Margin %']).replace(/[^0-9.-]/g, '')) || 0;
      let initialRate = 0;
      
      // For Carpet/Linen, "Unit Price AED" in mapping was treated as "Rate" (supplier price)
      // We should normalize it to Unit Price USD (the source column for Rate)
      let sourcePrice = initialPriceUSD;
      if (isCarpetOrLinen && initialPriceAED > 0 && initialPriceUSD === 0) {
        sourcePrice = initialPriceAED;
        newRow['Unit Price USD'] = sourcePrice.toFixed(2);
      }

      if (sourcePrice > 0) {
        let initialExchangeRate = parseFloat(headerSettings.exchangeRate);
        if (isNaN(initialExchangeRate) || initialExchangeRate === 0) initialExchangeRate = 1;
        
        // Rate AED calculation
        initialRate = sourcePrice * initialExchangeRate * (1 + initialMargin / 100);
      } else if (!isCarpetOrLinen && initialPriceAED > 0) {
        // Normal products mapping to Unit Price AED
        let initialExchangeRate = parseFloat(headerSettings.exchangeRate);
        if (isNaN(initialExchangeRate) || initialExchangeRate === 0) initialExchangeRate = 1;
        newRow['Unit Price USD'] = (initialPriceAED / initialExchangeRate).toFixed(2);
        initialRate = initialPriceAED * (1 + initialMargin / 100);
      }
      
      if (initialRate > 0) {
        if (!isCarpetOrLinen) {
          initialRate = Math.round(initialRate);
          if (pricingSettings.roundUpTo50) {
            initialRate = Math.ceil(initialRate / 100) * 100;
          }
        } else {
          initialRate = Number(initialRate.toFixed(2));
        }
      }
      
      newRow['Unit Price AED'] = String(initialRate);

      const parsedQtyOrArea = getQtyAreaFactor(newRow, isCarpetOrLinen);
      if (quoteDetails.isPO) {
        const usPrice = parseFloat(String(newRow['Unit Price USD'] || '0').replace(/[^0-9.-]/g, '')) || 0;
        newRow['Total'] = (usPrice * parsedQtyOrArea).toFixed(2);
      } else if (isCarpetOrLinen) {
        newRow['Total'] = (initialRate * parsedQtyOrArea).toFixed(2);
      } else {
        newRow['Total'] = String(Math.round(initialRate * parsedQtyOrArea));
      }

      const rowsToReturn: MappedData[] = [];
      if (mappedSubHeading && mappedSubHeading !== lastSubHeadingText) {
        lastSubHeadingText = mappedSubHeading;
        rowsToReturn.push({
          id: `item-${Date.now()}-${index}-sub`,
          sourceId: activeSourceId,
          isSubHeading: true,
          subHeadingText: mappedSubHeading,
          'Item Code': '',
          'Specification': '',
          'Material': '',
          'Size': '',
          'Qty': '',
          'Area': '',
          'Unit Price USD': '',
          'Unit Price AED': '',
          'Margin %': '',
          'Total': ''
        } as MappedData);
      }
      rowsToReturn.push(newRow as MappedData);

      return rowsToReturn;
    });
    
    setMappedData(prev => [...prev, ...finalData]);
    setIsMappingModalOpen(false);
  };

  const handleBulkRoundColumn = (field: string, roundFn: (val: number) => number) => {
    const isCurrentlyRounded = !!roundedColumns[field];

    setMappedData(prev => 
      prev.map(row => {
        if (row.isSubHeading) return row;
        
        let newVal: number | undefined;

        if (isCurrentlyRounded) {
            // Restore unrounded val
            if (row[`_unrounded_${field}`] !== undefined) {
               newVal = row[`_unrounded_${field}`];
            } else {
               newVal = parseFloat(String(row[field] || '0').replace(/[^0-9.-]/g, ''));
            }
        } else {
            // Round
            const currentVal = parseFloat(String(row[field] || '0').replace(/[^0-9.-]/g, ''));
            if (!isNaN(currentVal)) {
               newVal = roundFn(currentVal);
            }
        }

        if (newVal === undefined || isNaN(newVal)) return row;

        const newRow: any = { ...row, [field]: String(newVal) };
        if (!isCurrentlyRounded) {
            newRow[`_unrounded_${field}`] = parseFloat(String(row[field] || '0').replace(/[^0-9.-]/g, ''));
        } else {
            delete newRow[`_unrounded_${field}`];
        }

        if (['Unit Price USD', 'Unit Price AED'].includes(field)) {
           const header = supplierQuoteHeaders.find(h => h.id === row.sourceId) || supplierQuoteHeaders[0];
           
           if (field === 'Unit Price USD') {
             const unitPrice = newVal;
             const margin = parseFloat(String(row['Margin %']).replace(/[^0-9.-]/g, '')) || 0;
             const exchangeRate = parseFloat(header?.exchangeRate || '1');
             const effectiveExchangeRate = exchangeRate === 0 ? 1 : (exchangeRate || 1);
             let usRate = unitPrice * effectiveExchangeRate * (1 + margin / 100);
             if (!isCarpetOrLinen) {
               usRate = Math.round(usRate);
               if (pricingSettings.roundUpTo50) {
                 usRate = Math.ceil(usRate / 100) * 100;
               }
             } else {
               usRate = Number(usRate.toFixed(2));
             }
             newRow['Unit Price AED'] = String(usRate);
            }
            if (quoteDetails.isPO) {
              newRow['Unit Price AED'] = String(newRow['Unit Price USD'] || '0');
           }

           let rate = parseFloat(String(newRow['Unit Price AED']).replace(/[^0-9.]/g, '')) || 0;
           const qtyOrArea = parseFloat(String(row[isCarpetOrLinen ? 'Area' : 'Qty']).replace(/[^0-9.]/g, '')) || 0;
           
           if (quoteDetails.isPO) {
             const usPrice = parseFloat(String(newRow['Unit Price USD'] || '0').replace(/[^0-9.-]/g, '')) || 0;
             newRow['Total'] = (usPrice * qtyOrArea).toFixed(2);
           } else if (isCarpetOrLinen) {
             newRow['Total'] = (rate * qtyOrArea).toFixed(2);
           } else {
             newRow['Total'] = String(Math.round(rate * qtyOrArea));
           }
        }
        return newRow;
      })
    );

    setRoundedColumns(prev => ({
      ...prev,
      [field]: !isCurrentlyRounded
    }));
  };

   const updateField = (id: string, field: string, value: string) => {
    setMappedData(prev => 
      prev.map(row => {
        if (row.id !== id) return row;
        const newRow = { ...row, [field]: value };
        // Remember that this row's margin was set individually, so the header-margin
        // recalculation effect won't overwrite it with the supplier's overall margin.
        if (field === 'Margin %') {
          newRow.marginCustom = true;
        }
        
        // Auto-calculate Rate and Total if dependencies change
        if (['Unit Price USD', 'Margin %', 'Qty', 'Area', 'Unit Price AED'].includes(field)) {
           const header = supplierQuoteHeaders.find(h => h.id === row.sourceId) || supplierQuoteHeaders[0];
           
           let rate = parseFloat(String(newRow['Unit Price AED']).replace(/[^0-9.]/g, '')) || 0;
           
           if (field !== 'Unit Price AED') {
             const unitPrice = parseFloat(String(newRow['Unit Price USD']).replace(/[^0-9.]/g, '')) || 0;
             const margin = parseFloat(String(newRow['Margin %']).replace(/[^0-9.-]/g, '')) || 0;
             const exchangeRate = parseFloat(header?.exchangeRate || '1');
             const effectiveExchangeRate = exchangeRate === 0 ? 1 : (exchangeRate || 1);
             
             if (unitPrice > 0 || field === 'Margin %' || field === 'Unit Price USD') {
               rate = unitPrice * effectiveExchangeRate * (1 + margin / 100);
               if (!isCarpetOrLinen) {
                 rate = Math.round(rate);
                 if (pricingSettings.roundUpTo50) {
                   rate = Math.ceil(rate / 100) * 100;
                 }
               } else {
                 rate = Number(rate.toFixed(2));
                 if (roundRateAED) {
                   rate = Math.ceil(rate);
                 }
               }
               newRow['Unit Price AED'] = String(rate);
            }
            if (quoteDetails.isPO) {
              newRow['Unit Price AED'] = String(newRow['Unit Price USD'] || '0');
             }
           }

           const qtyOrArea = getQtyAreaFactor(newRow, isCarpetOrLinen);
           if (quoteDetails.isPO) {
             const usPrice = parseFloat(String(newRow['Unit Price USD'] || '0').replace(/[^0-9.-]/g, '')) || 0;
             newRow['Total'] = (usPrice * qtyOrArea).toFixed(2);
           } else if (isCarpetOrLinen) {
             newRow['Total'] = (rate * qtyOrArea).toFixed(2);
           } else {
             newRow['Total'] = String(Math.round(rate * qtyOrArea));
           }
        }

        return newRow;
      })
    );
  };

  const removeRow = (id: string) => {
    setMappedData(prev => prev.filter(row => row.id !== id));
  };

  const addRow = () => {
    const newRow: any = { id: `item-${Date.now()}` };
    ALL_FIELDS.forEach(field => {
      newRow[field] = field === 'Qty' ? '1' : '';
    });
    setMappedData(prev => [...prev, newRow as MappedData]);
  };

  const insertRow = (index: number, sourceId?: string) => {
    const newRow: any = { id: `item-${Date.now()}` };
    if (sourceId) {
      newRow.sourceId = sourceId;
    }
    ALL_FIELDS.forEach(field => {
      newRow[field] = field === 'Qty' ? '1' : '';
    });
    setMappedData(prev => {
      const copy = [...prev];
      copy.splice(index, 0, newRow as MappedData);
      return copy;
    });
  };

  const insertSubHeading = (index: number, sourceId?: string) => {
    const newRow: any = { id: `item-${Date.now()}`, isSubHeading: true, subHeadingText: 'New Sub Heading' };
    if (sourceId) {
      newRow.sourceId = sourceId;
    }
    setMappedData(prev => {
      const copy = [...prev];
      copy.splice(index, 0, newRow);
      return copy;
    });
  };

  const duplicateRow = (id: string) => {
    const idx = mappedData.findIndex(r => r.id === id);
    if (idx === -1) return;
    const rowToCopy = mappedData[idx];
    const newRow = { ...rowToCopy, id: `item-${Date.now()}` };
    setMappedData(prev => {
      const copy = [...prev];
      copy.splice(idx + 1, 0, newRow);
      return copy;
    });
  };

  const insertRowAtEndOfSupplier = (sourceId: string) => {
    let lastIndex = mappedData.map(r => r.sourceId).lastIndexOf(sourceId);
    if (lastIndex === -1) lastIndex = mappedData.length - 1;
    insertRow(lastIndex + 1, sourceId);
  };

  const handleReorder = (headerId: string, newOrder: MappedData[]) => {
    setMappedData(prev => {
      const defaultId = supplierQuoteHeaders.length > 0 ? supplierQuoteHeaders[0].id : null;
      let currentIndex = 0;
      return prev.map(row => {
        const rowSourceId = row.sourceId || defaultId;
        if (rowSourceId === headerId) {
          return newOrder[currentIndex++];
        }
        return row;
      });
    });
  };

  const handleImageUpload = (rowId: string, file: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (e) => {
      const imgBase64 = e.target?.result as string;
      const compressed = await compressImage(imgBase64);
      setMappedData(prev => prev.map(row => row.id === rowId ? { ...row, image: compressed } : row));
      toast.success("Image uploaded successfully");
    };
    reader.onerror = () => {
      toast.error("Failed to read image file");
    };
    reader.readAsDataURL(file);
  };

  const imageInputRef = useRef<HTMLInputElement>(null);
  const [activeImageRowId, setActiveImageRowId] = useState<string | null>(null);
  const [focusedRowId, setFocusedRowId] = useState<string | null>(null);

  // Global paste handler to ensure copy-pasting an image works flawlessly even if the row loses focus
  useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
      // If we are actively editing a row, or we clicked on a row
      const targetRowId = focusedRowId || mappedData[mappedData.length - 1]?.id;
      if (!targetRowId) return;

      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const blob = items[i].getAsFile();
          if (blob) {
            handleImageUpload(targetRowId, blob);
            e.preventDefault();
            break;
          }
        }
      }
    };

    window.addEventListener('paste', handleGlobalPaste);
    return () => window.removeEventListener('paste', handleGlobalPaste);
  }, [focusedRowId, mappedData]);

  const handleImageUploadClick = (rowId: string) => {
    setActiveImageRowId(rowId);
    imageInputRef.current?.click();
  };

  const handleImagePasteClick = async (rowId: string) => {
    setActiveImageRowId(rowId);
    try {
      const clipboardItems = await navigator.clipboard.read();
      let hasImage = false;
      for (const clipboardItem of clipboardItems) {
        for (const type of clipboardItem.types) {
          if (type.startsWith('image/')) {
            const blob = await clipboardItem.getType(type);
            handleImageUpload(rowId, new File([blob], 'pasted.png', { type }));
            hasImage = true;
            return;
          }
        }
      }
      if (!hasImage) {
        toast.error("No image found in clipboard");
      }
    } catch (err) {
      console.error("Paste failed", err);
      toast.error("Clipboard permission denied or unavailable. Please use Ctrl+V / Cmd+V.");
    }
  };

  const handleImageFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && activeImageRowId) {
      handleImageUpload(activeImageRowId, file);
    }
    if (imageInputRef.current) {
      imageInputRef.current.value = '';
    }
    setActiveImageRowId(null);
  };
  
  const handleSaveClick = () => {
    const openedFromProjectId = localStorage.getItem('artizio_opened_from_project_id');
    if (openedFromProjectId) {
      handleSaveQuote(openedFromProjectId);
    } else {
      setIsSaveModalOpen(true);
    }
  };

  // Auto-creates a Requirements line item for each supplier in a saved quote.
  // Only applies to actual Quotes (not PO/Invoice/DN) since those represent supplier cost requirements.
  const buildAutoLineItems = (quoteData: any, existingLineItems: LineItem[] = []): LineItem[] => {
    if (quoteDetails.isPO || quoteDetails.isInvoice || quoteDetails.isDO) return existingLineItems;
    const updatedLineItems = [...existingLineItems];
    const existingSupplierIds = new Set(updatedLineItems.map(li => li.supplierId).filter(Boolean));

    (quoteData.supplierQuoteHeaders || []).forEach((header: any) => {
      if (!header.supplier) return;
      const matchedSupplier = (suppliers || []).find(s => s.name === header.supplier);
      if (!matchedSupplier || existingSupplierIds.has(matchedSupplier.id)) return;

      const supplierTotal = quoteData.supplierCosts?.[header.supplier] !== undefined
        ? quoteData.supplierCosts[header.supplier]
        : (quoteData.totalUSD || 0);

      let matchedRequirementId = '';
      if (matchedSupplier.category) {
        const matchingReq = (requirements || []).find(r => r.name.toLowerCase() === matchedSupplier.category!.toLowerCase());
        if (matchingReq) matchedRequirementId = matchingReq.id;
      }

      updatedLineItems.push({
        id: `li-${Date.now()}-${matchedSupplier.id}`,
        requirementId: matchedRequirementId,
        supplierId: matchedSupplier.id,
        designerId: '',
        itemSelectorId: '',
        statusId: '',
        quoteAmount: String(supplierTotal.toFixed(2)),
        quoteNo: quoteData.quoteNo || quoteData.quoteNumber || '',
        shippingChargeStatusId: '',
        shippingAgentId: '',
        lastFollowUp: '',
        nextFollowUp: '',
        remarks: ''
      });
      existingSupplierIds.add(matchedSupplier.id);
    });

    return updatedLineItems;
  };

  const handleSaveQuote = async (opProjectId?: string, bypassPrompt = false, incrementSerial = false) => {
    console.log('[SaveQuote] called', { opProjectId, bypassPrompt, incrementSerial });
    const isDirectSave = typeof opProjectId === 'string';
    const finalSaveMode = isDirectSave ? 'existing' : saveMode;
    const finalSaveProjectId = isDirectSave ? opProjectId : selectedSaveProjectId;

    if (finalSaveMode === 'new' && !newSaveProjectName.trim()) {
      toast.error('Please enter a project name');
      return;
    }
    if (finalSaveMode === 'existing' && !finalSaveProjectId) {
      toast.error('Please select a project');
      return;
    }

    const savedQuoteId = localStorage.getItem('artizio_quote_id');

    let existingItem: any = null;

    if (finalSaveMode === 'existing' && finalSaveProjectId && savedQuoteId) {
      const existingProject = projects.find(p => p.id === finalSaveProjectId);
      if (existingProject) {
        if (quoteDetails.isDO) {
          existingItem = (existingProject.dos || []).find((d: any) => d.id === savedQuoteId);
        } else if (quoteDetails.isPO) {
          existingItem = (existingProject.pos || []).find((po: any) => po.id === savedQuoteId);
        } else if (quoteDetails.isInvoice) {
          existingItem = (existingProject.invoices || []).find((inv: any) => inv.id === savedQuoteId);
        } else {
          existingItem = (existingProject.quotes || []).find((q: any) => q.id === savedQuoteId);
        }
      }
    }

    // Show the overwrite/new prompt whenever we're saving over an existing document, so the
    // user always chooses. (Previously the prompt was skipped when the category differed —
    // which happens automatically when the supplier is changed — causing a silent save-as-new.)
    if (existingItem && !bypassPrompt) {
      console.log('[SaveQuote] showing serial prompt (existing item)');
      setPendingSaveParams({ opProjectId });
      setShowSerialPrompt(true);
      return;
    }

    // Now compute the ID to save under.
    let targetQuoteId = savedQuoteId || `quote-${Date.now()}`;
    if (bypassPrompt && incrementSerial) {
      targetQuoteId = `quote-${Date.now()}`;
    }
    
    // Always store the quote ID after it is determined, preventing multiple saves of the same new quote
    localStorage.setItem('artizio_quote_id', targetQuoteId);

    // Compute active quotation number:
    let activeQuotationNumber = quoteDetails.quotationNumber;
    if (bypassPrompt && incrementSerial) {
      activeQuotationNumber = getNextSerialNumber(quoteDetails.quotationNumber);
      // Update state so the UI displays the incremented number
      setQuoteDetails(prev => ({
        ...prev,
        quotationNumber: activeQuotationNumber
      }));
    }

    const categoryUpper = (quoteDetails.category || 'CATEGORY').toUpperCase();
    const quoteName = quoteDetails.isDO
      ? `DN-${categoryUpper}`
      : quoteDetails.isPO
      ? `PO-${categoryUpper}`
      : quoteDetails.isInvoice 
      ? `INVOICE-${categoryUpper}`
      : `QUOTE-${categoryUpper}`;

    const currentQuoteDetails = {
      ...quoteDetails,
      quotationNumber: activeQuotationNumber
    };

    import('../utils/indexedDB').then(({ saveQuotesToDB }) => {
      saveQuotesToDB(mappedData, targetQuoteId);
    });

    const currentQuoteData = JSON.parse(JSON.stringify({
      id: targetQuoteId,
      quoteName,
      createdAt: Date.now(),
      quoteNumber: activeQuotationNumber || '',
      clientInfo: clientInfo || {},
      quoteDetails: currentQuoteDetails,
      supplierQuoteHeaders: supplierQuoteHeaders || [],
      // Compress base64 images to ensure they persist and don't exceed Firestore limits
      mappedData: await Promise.all((mappedData || []).map(async (item: any) => {
         const cleaned = { ...item };
         if (cleaned.image && cleaned.image.startsWith('data:image')) {
            cleaned.image = await compressImage(cleaned.image, 200, 200, 0.4);
         }
         return cleaned;
      })),
      pricingSettings: pricingSettings || {},
      quoteNotes: quoteNotes || '',
      quoteTerms: quoteTerms || '',
      supplierCosts: (supplierQuoteHeaders || []).reduce((acc: any, header: any) => {
        const cost = (mappedData || []).reduce((sum: number, row: any) => {
          if (row.isSubHeading) return sum;
          // Match row to header, or assume first header if no sourceId
          if (row.sourceId !== header.id && (row.sourceId || header.id !== supplierQuoteHeaders[0].id)) return sum;
          
          const p = parseFloat(String(row['Unit Price USD'] || '0').replace(/[^0-9.-]/g, ''));
          const q = parseFloat(String(row[isCarpetOrLinen ? 'Area' : 'Qty'] || '1').replace(/[^0-9.-]/g, ''));
          const val = (isNaN(p) ? 0 : p) * (isNaN(q) ? 1 : q);
          return sum + (isNaN(val) ? 0 : val);
        }, 0);
        if (header.supplier) acc[header.supplier] = cost;
        return acc;
      }, {}),
      totalUSD: mappedData.reduce((sum, row) => {
        const p = parseFloat(String(row['Unit Price USD']).replace(/[^0-9.-]/g, ''));
        const q = parseFloat(String(row[isCarpetOrLinen ? 'Area' : 'Qty']).replace(/[^0-9.-]/g, ''));
        const val = (isNaN(p) ? 0 : p) * (isNaN(q) ? 1 : q);
        return sum + (isNaN(val) ? 0 : val);
      }, 0),
      totalAED: (() => {
        const subtotal = mappedData.reduce((sum, row) => {
          const val = parseFloat(String(row['Total']).replace(/[^0-9.-]/g, ''));
          return sum + (isNaN(val) ? 0 : val);
        }, 0);
        const pSettings = pricingSettings || {};
        const discountType = pSettings.discountType || 'Fixed';
        const discountValue = pSettings.discountValue || 0;
        const discount = discountType === '%' ? (subtotal * discountValue / 100) : discountValue;
        const afterDiscount = subtotal - discount;
        const vat = (pSettings.vatEnabled === false) ? 0 : afterDiscount * ((parseFloat(quoteDefaults?.defaultVat || '5')) / 100);
        let grandTotal = afterDiscount + vat + (pSettings.shipping || 0);
        if (pSettings.roundGrandTotal) {
           grandTotal = Math.ceil(grandTotal / 100) * 100;
        }
        return grandTotal;
      })(),
    }));

    setIsSaveModalOpen(false);
    
    // Cache UI state variables locally
    const cachedNewSaveProjectName = newSaveProjectName.trim();
    
    setNewSaveProjectName('');
    setSelectedSaveProjectId('');

    try {
      console.log('[SaveQuote] in try, finalSaveMode =', finalSaveMode, 'projectId =', finalSaveProjectId, 'projectsCount =', projects.length);
      if (finalSaveMode === 'new') {
        const newProject: Project = {
          id: `proj-${Date.now()}`,
          name: cachedNewSaveProjectName,
          clientName: clientInfo.name || '',
          designerId: '',
          createdAt: Date.now(),
          order: projects.length,
          deadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          statusId: '', // Ideally a valid status ID
          notes: '',
          lineItems: buildAutoLineItems(currentQuoteData, []),
          quotes: (quoteDetails.isInvoice || quoteDetails.isPO || quoteDetails.isDO) ? [] : [currentQuoteData],
          invoices: quoteDetails.isInvoice ? [currentQuoteData] : [],
          pos: quoteDetails.isPO ? [currentQuoteData] : [],
          dos: quoteDetails.isDO ? [currentQuoteData] : []
        };
        await Promise.race([
          addProject(newProject.id, newProject),
          new Promise((_, rej) => setTimeout(() => rej(new Error('WRITE_TIMEOUT')), 15000)),
        ]);
        localStorage.setItem('artizio_opened_from_project_id', newProject.id);
        console.log('[SaveQuote] addProject done — showing success toast');
        toast.success(`${quoteDetails.isDO ? 'Delivery Note' : quoteDetails.isPO ? 'Purchase Order' : quoteDetails.isInvoice ? 'Invoice' : 'Quote'} saved successfully`, { duration: 3000 });
        // Trigger silent background backup
        triggerSilentBackup();
      } else {
        const existingProject = projects.find(p => p.id === finalSaveProjectId);
        console.log('[SaveQuote] existing branch, existingProject found =', !!existingProject);
        if (existingProject) {
          // Update line items if they match the supplier of the current quote
          let updatedLineItems = [...(existingProject.lineItems || [])];
          updatedLineItems = updatedLineItems.map(item => {
            const supplier = (suppliers || []).find(s => s.id === item.supplierId);
            if (supplier && currentQuoteData.supplierCosts?.[supplier.name] !== undefined) {
              return {
                ...item,
                quoteAmount: String(currentQuoteData.supplierCosts[supplier.name].toFixed(2)),
                quoteNo: currentQuoteData.quoteNo || currentQuoteData.quoteNumber || item.quoteNo
              };
            }
            if (supplier && currentQuoteData.supplierQuoteHeaders?.[0]?.supplier === supplier.name) {
              return {
                ...item,
                quoteAmount: String((currentQuoteData.totalUSD || 0).toFixed(2)),
                quoteNo: currentQuoteData.quoteNo || currentQuoteData.quoteNumber || item.quoteNo
              };
            }
            return item;
          });

          // Auto-create a Requirements line item for each supplier in this quote that doesn't already have one
          updatedLineItems = buildAutoLineItems(currentQuoteData, updatedLineItems);
          
          const updateData: Partial<Project> = { lineItems: updatedLineItems };
          if (quoteDetails.isDO) {
             const existingDOs = [...(existingProject.dos || [])];
             const index = existingDOs.findIndex(d => d.id === currentQuoteData.id);
             if (index >= 0) {
                 existingDOs[index] = currentQuoteData;
             } else {
                 existingDOs.push(currentQuoteData);
             }
             updateData.dos = existingDOs;
          } else if (quoteDetails.isPO) {
             const existingPOs = [...(existingProject.pos || [])];
             const index = existingPOs.findIndex(po => po.id === currentQuoteData.id);
             if (index >= 0) {
                 existingPOs[index] = currentQuoteData;
             } else {
                 existingPOs.push(currentQuoteData);
             }
             updateData.pos = existingPOs;
          } else if (quoteDetails.isInvoice) {
             const existingInvoices = [...(existingProject.invoices || [])];
             const index = existingInvoices.findIndex(inv => inv.id === currentQuoteData.id);
             if (index >= 0) {
                 existingInvoices[index] = currentQuoteData;
             } else {
                 existingInvoices.push(currentQuoteData);
             }
             updateData.invoices = existingInvoices;
          } else {
             const existingQuotes = [...(existingProject.quotes || [])];
             const index = existingQuotes.findIndex(q => q.id === currentQuoteData.id);
             if (index >= 0) {
                 existingQuotes[index] = currentQuoteData;
             } else {
                 existingQuotes.push(currentQuoteData);
             }
             updateData.quotes = existingQuotes;
          }
          if (existingProject.createdAt === undefined) updateData.createdAt = Date.now();
          if (existingProject.order === undefined) updateData.order = projects.length;
          
          await Promise.race([
            updateProject(existingProject.id, updateData),
            new Promise((_, rej) => setTimeout(() => rej(new Error('WRITE_TIMEOUT')), 15000)),
          ]);
          localStorage.setItem('artizio_opened_from_project_id', existingProject.id);
          console.log('[SaveQuote] updateProject done — showing success toast');
          toast.success(`${quoteDetails.isDO ? 'Delivery Note' : quoteDetails.isPO ? 'Purchase Order' : quoteDetails.isInvoice ? 'Invoice' : 'Quote'} saved successfully`, { duration: 3000 });
          // Trigger silent background backup
          triggerSilentBackup();
        }
      }
      if (onNavigate) {
        // Brief delay so the "saved successfully" toast is visible before we leave the editor.
        setTimeout(() => onNavigate('back'), 800);
      }
    } catch (error: any) {
      console.error("Error saving quote:", error);
      const msg = String(error?.message || error);
      if (msg.includes('WRITE_TIMEOUT') || msg.includes('resource-exhausted') || msg.includes('exhausted')) {
        toast.error("Save is stuck — this device's offline cache is full. Open Settings and use 'Clear cache & reload', then try again.", { duration: 7000 });
      } else {
        toast.error(quoteDetails.isInvoice ? 'Failed to save invoice' : 'Failed to save quote');
      }
    }
  };


  const exportToExcel = async () => {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(quoteDetails.isDO ? 'Delivery Note' : quoteDetails.isPO ? 'Purchase Order' : quoteDetails.isInvoice ? 'Invoice' : 'Quotation');

    // Add headers
    const cols: any[] = [];
    currentStandardFields.forEach(f => {
      if (f === 'Image') {
        cols.push({ header: 'Image', key: 'img', width: 15 });
      } else {
        const headerText = f === 'Unit Price USD' ? `Unit Price ${displayCurrency}` : (f === 'Area' ? `Area (${areaUnit})` : f);
        cols.push({ header: headerText, key: f, width: 20 });
      }
    });
    worksheet.columns = cols;

    // Add rows
    for (let i = 0; i < mappedData.length; i++) {
      const rowData = mappedData[i];
      if (rowData.isSubHeading) {
        const row = worksheet.addRow([rowData.subHeadingText]);
        worksheet.mergeCells(`A${i + 2}:H${i + 2}`); // A is 1, H is 8 columns
        row.font = { bold: true, size: 14 };
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
        continue;
      }

      const rowValues: any = {};
      currentStandardFields.forEach(f => {
        if (f !== 'Image') rowValues[f] = rowData[f as keyof MappedData];
      });
      
      const row = worksheet.addRow(rowValues);
      row.height = 80;

      if (rowData.image && rowData.image.startsWith('data:image')) {
        try {
          // Add image to workbook
          const imageId = workbook.addImage({
            base64: rowData.image,
            extension: 'jpeg',
          });
          
          const imageColIndex = currentStandardFields.indexOf('Image');
          worksheet.addImage(imageId, {
            tl: { col: imageColIndex, row: i + 1 }, // col is 0-indexed in coordinates
            ext: { width: 80, height: 80 }
          });
        } catch (e) {
          console.error("Failed to add image to excel export", e);
        }
      }
    }

    // Generate blob
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    saveAs(blob, `Quotation_Export_${new Date().toISOString().slice(0,10)}.xlsx`);
  };

  const [isExportingPDF, setIsExportingPDF] = useState(false);
  const [isDownloadingPDF, setIsDownloadingPDF] = useState(false);
  const [hideImageInPrint, setHideImageInPrint] = useState(false);
  const [hideRemarksInPrint, setHideRemarksInPrint] = useState(false);
  const [hideMaterialInPrint, setHideMaterialInPrint] = useState(false);
  const [hideSpecificationInPrint, setHideSpecificationInPrint] = useState(false);

  // Send Modal States
  const [isSendModalOpen, setIsSendModalOpen] = useState(false);
  const [sendMethod, setSendMethod] = useState<'email' | 'whatsapp'>('email');
  const [sendSubject, setSendSubject] = useState('');
  const [sendMessage, setSendMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [includeAttachment, setIncludeAttachment] = useState(true);

  // Builds the standardised PDF filename: Artizio_<ProjectName>_<SupplierCategory>_Quote
  // Falls back gracefully if fields are empty.
  const buildPDFFilename = (): string => {
    const project = (quoteDetails.referenceProject || '').trim().replace(/\s+/g, '_') || 'Project';
    const category = (quoteDetails.category || '').trim().replace(/\s+/g, '_') || 'General';
    let docType = 'Quote';
    if (quoteDetails.isDO) docType = 'Delivery_Note';
    else if (quoteDetails.isPO) docType = 'Purchase_Order';
    else if (quoteDetails.isInvoice) docType = 'Invoice';
    return `Artizio_${project}_${category}_${docType}.pdf`;
  };

  const openSendModal = () => {
    let suffix = 'Quotation';
    if (quoteDetails.isDO) suffix = 'Delivery Note';
    else if (quoteDetails.isPO) suffix = 'Purchase Order';
    else if (quoteDetails.isInvoice) suffix = 'Tax Invoice';
    
    setSendSubject(`${suffix} - ${quoteDetails.quotationNumber || 'Pending'}`);
    setSendMessage(`Hello,\n\nPlease find attached the ${suffix} (${quoteDetails.quotationNumber || 'Pending'}). Let us know if you have any questions.\n\nBest regards,\nThe Team`);
    setIsSendModalOpen(true);
  };

  const generatePDFBlob = async (): Promise<Blob | null> => {
    const printElement = document.getElementById('print-container');
    if (!printElement) return null;

    // Remove hidden so it renders, but make it invisible via opacity/z-index
    printElement.classList.remove('hidden');
    printElement.classList.add('block');
    const originalStyle = printElement.getAttribute('style') || '';
    
    // Position it at top left but behind everything and transparent so it doesn't flicker visually
    printElement.style.position = 'absolute';
    printElement.style.top = '0';
    printElement.style.left = '0';
    printElement.style.width = '210mm'; // Standard A4 width
    printElement.style.opacity = '0';
    printElement.style.pointerEvents = 'none';
    printElement.style.zIndex = '-9999';

    // Ensure async rendering and fonts finish (kept short to avoid a sluggish feel)
    await new Promise(resolve => setTimeout(resolve, 150));
    
    try {
      const canvas = await html2canvas(printElement, { 
        scale: 1.5, 
        useCORS: true, 
        backgroundColor: '#ffffff',
        windowWidth: printElement.scrollWidth,
        windowHeight: printElement.scrollHeight
      });

      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = pdf.internal.pageSize.getHeight();

      const canvasWidth = canvas.width;
      const canvasHeight = canvas.height;
      // Pixels of the source canvas that map to one full PDF page height
      const pxPerPage = (pdfHeight * canvasWidth) / pdfWidth;

      // Find vertical positions (in canvas px) of each subheading row so we never
      // cut a page right after a subheading — if a break would land just after a
      // subheading, we move the break up to just before it so it travels with its rows.
      const containerRect = printElement.getBoundingClientRect();
      const scaleY = canvasHeight / printElement.scrollHeight;
      const subheadingTops: number[] = [];
      printElement.querySelectorAll('.subheading-row').forEach((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        const topInContainer = (r.top - containerRect.top) * scaleY;
        subheadingTops.push(topInContainer);
      });
      // Approx height of a subheading + one following row, in canvas px (used as the "keep together" zone)
      const keepZone = 90 * scaleY; // ~90 CSS px ≈ subheading + first row

      let renderedHeight = 0;
      let pageNum = 0;
      while (renderedHeight < canvasHeight - 1) {
        let sliceHeight = Math.min(pxPerPage, canvasHeight - renderedHeight);
        let breakAt = renderedHeight + sliceHeight;

        // If a subheading starts within the keepZone just above the proposed break,
        // pull the break up to that subheading's top so it moves to the next page.
        if (breakAt < canvasHeight - 1) {
          for (const top of subheadingTops) {
            if (top > breakAt - keepZone && top < breakAt) {
              breakAt = Math.floor(top);
              break;
            }
          }
          sliceHeight = breakAt - renderedHeight;
        }
        if (sliceHeight <= 0) sliceHeight = Math.min(pxPerPage, canvasHeight - renderedHeight); // safety

        // Draw this slice onto a temp canvas
        const pageCanvas = document.createElement('canvas');
        pageCanvas.width = canvasWidth;
        pageCanvas.height = sliceHeight;
        const ctx = pageCanvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvasWidth, sliceHeight);
          ctx.drawImage(canvas, 0, renderedHeight, canvasWidth, sliceHeight, 0, 0, canvasWidth, sliceHeight);
        }
        const pageImg = pageCanvas.toDataURL('image/jpeg', 0.85);
        const slicePdfHeight = (sliceHeight * pdfWidth) / canvasWidth;

        if (pageNum > 0) pdf.addPage();
        pdf.addImage(pageImg, 'JPEG', 0, 0, pdfWidth, slicePdfHeight);

        renderedHeight += sliceHeight;
        pageNum++;
        if (pageNum > 50) break; // safety against runaway loops
      }

      return pdf.output('blob');
    } catch (e) {
      console.error("PDF Generation error", e);
      return null;
    } finally {
      printElement.classList.add('hidden');
      printElement.classList.remove('block');
      printElement.setAttribute('style', originalStyle);
    }
  };

  const handleSendDocument = async () => {
    setIsSending(true);
    try {
      let file: File | null = null;

      if (includeAttachment) {
        const blob = await generatePDFBlob();
        if (blob) {
          const filename = buildPDFFilename();
          file = new File([blob], filename, { type: 'application/pdf' });
        }
      }

      if (sendMethod === 'whatsapp') {
        // For WhatsApp: Web Share API cannot reliably target WhatsApp specifically,
        // so we always download the PDF first (so the user has it ready to attach),
        // then open WhatsApp with the pre-filled message text.
        if (file) {
          saveAs(file, file.name);
          toast.success(
            "PDF downloaded! Open WhatsApp, start a chat, tap the attachment icon, and select the downloaded file.",
            { duration: 6000 }
          );
          // Small delay so the download starts before we switch tabs
          await new Promise(resolve => setTimeout(resolve, 600));
        }
        window.open(`https://wa.me/?text=${encodeURIComponent(sendMessage)}`, '_blank');
        setIsSendModalOpen(false);
        return;
      }

      // Email path: try native Web Share API first (works great on mobile)
      if (navigator.share) {
        const shareData: any = {
          title: sendSubject,
          text: sendMessage
        };
        
        if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
          shareData.files = [file];
        }
        
        try {
          await navigator.share(shareData);
          toast.success('Opened share dialog');
          setIsSendModalOpen(false);
          return;
        } catch (err: any) {
           if (err.name === 'AbortError') {
             setIsSendModalOpen(false);
             return;
           }
        }
      }

      // Fallback: download PDF then open mailto
      if (file) {
        saveAs(file, file.name);
        toast.success("Document downloaded. Please attach it manually.");
      }
      window.open(`mailto:?subject=${encodeURIComponent(sendSubject)}&body=${encodeURIComponent(sendMessage)}`, '_blank');
      setIsSendModalOpen(false);
    } catch (err: any) {
      console.error("Share Error", err);
      toast.error(err.message || 'Failed to share');
    } finally {
      setIsSending(false);
    }
  };

  // ... (keep previous export logic intact inside component above) ...
  
  const exportToPDF = async () => {
    setIsExportingPDF(true);
    
    try {
      await document.fonts.ready;

      const printElement = document.getElementById('print-container');
      const printWindow = window.open('', '_blank');
      
      if (printWindow) {
        const printHtml = `
          <!DOCTYPE html>
          <html>
            <head>
              <title>${buildPDFFilename().replace('.pdf', '')}</title>
              ${Array.from(document.querySelectorAll('style, link[rel="stylesheet"]')).map(el => el.outerHTML).join('\n')}
              <style>
                @font-face {
                  font-family: 'Grift';
                  src: url('${window.location.origin}/fonts/grift-medium.ttf') format('truetype');
                  font-weight: 500;
                  font-style: normal;
                }
                @page { size: A4; margin: 10mm 10mm; }
                body { 
                  font-family: 'Grift', sans-serif !important; 
                  background: white; 
                  -webkit-print-color-adjust: exact; 
                  print-color-adjust: exact; 
                  margin: 0; 
                  padding: 20px 40px; 
                }
                * { font-family: 'Grift', sans-serif !important; box-sizing: border-box; }
                .page-break { page-break-inside: avoid; break-inside: avoid; }
              </style>
            </head>
            <body>
              ${printElement ? printElement.innerHTML : ''}
              <script>
                window.onload = async () => {
                  try { await document.fonts.ready; } catch(e) {}
                  setTimeout(() => {
                    window.print();
                  }, 250);
                };
              </script>
            </body>
          </html>
        `;

        printWindow.document.open();
        printWindow.document.write(printHtml);
        printWindow.document.close();
      } else {
        // Fallback for popup blocker
        toast.error("Pop-up blocked. Please allow pop-ups to see the print preview.");
        window.print();
      }
    } catch (e: any) {
      console.error("Failed to Print", e);
      window.print();
    } finally {
      setIsExportingPDF(false);
    }
  };
  
  useEffect(() => {
    return () => {
      if (previewUrl && previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  return (
    <main className="flex-1 flex flex-col overflow-y-auto overflow-x-hidden bg-transparent w-full h-full custom-scrollbar">
      {/* Sticky Back to Project Files bar — stays frozen while everything else scrolls */}
      {localStorage.getItem('artizio_opened_from_project_id') && (
        <div className="sticky top-0 z-40 bg-app-base/95 backdrop-blur-sm border-b border-white/5 w-full">
          <div className="px-6 md:px-10 py-3 max-w-[1540px] mx-auto w-full">
            <button 
              onClick={async () => {
                const opProjectId = localStorage.getItem('artizio_opened_from_project_id');
                if ((quoteDetails.isPO || quoteDetails.isDO) && opProjectId) {
                  await handleSaveQuote(opProjectId, true, false);
                }
                
                localStorage.setItem('artizio_project_tab', 'files');
                if (onNavigate) {
                  onNavigate('engagements');
                } else {
                  localStorage.setItem('app_activeTab', JSON.stringify('engagements'));
                  window.location.reload();
                }
              }}
              className="flex items-center gap-2 text-sm font-medium text-slate-400 hover:text-white transition-colors group w-fit"
            >
              <div className="p-1 rounded bg-white/5 group-hover:bg-white/10 transition-colors">
                <ArrowLeft className="w-4 h-4" />
              </div>
              Back to Project Files
            </button>
          </div>
        </div>
      )}

      <div className="pt-6 md:pt-10 px-6 md:px-10 flex flex-col shrink-0 max-w-[1540px] mx-auto w-full">
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-end mb-8 gap-4">
        <div className="max-w-sm">
          <h1 className="text-3xl md:text-2xl lg:text-3xl font-semibold text-white tracking-tight flex items-center gap-3 whitespace-nowrap">
            {quoteDetails.isInvoice ? (
              <Receipt className="w-8 h-8 text-primary shrink-0" />
            ) : quoteDetails.isPO ? (
              <Briefcase className="w-8 h-8 text-primary shrink-0" />
            ) : quoteDetails.isDO ? (
              <Truck className="w-8 h-8 text-primary shrink-0" />
            ) : (
              <Settings2 className="w-8 h-8 text-primary shrink-0" />
            )}
            {quoteDetails.isInvoice
              ? 'Invoice Editor'
              : quoteDetails.isPO
              ? 'Purchase Order Editor'
              : quoteDetails.isDO
              ? 'Delivery Note Editor'
              : 'Supplier Quotes Extractor'}
          </h1>
          <p className="text-slate-400 mt-2 text-sm font-medium">
            {quoteDetails.isInvoice
              ? 'Manage and edit tax invoices, adjust quantities, prices, and settings.'
              : quoteDetails.isPO
              ? 'Manage and edit purchase orders, adjust quantities, rates, and suppliers.'
              : quoteDetails.isDO
              ? 'Manage and edit delivery notes (DN), adjust quantities, details, and delivery locations.'
              : 'Upload supplier Excel files, precisely extract structured data & product images without AI.'}
          </p>
        </div>
        
        {(() => {
          const hasAnyData = mappedData.length > 0 || 
            !!clientInfo.name || !!clientInfo.email || !!clientInfo.deliveryAddress || !!clientInfo.billingAddress ||
            !!quoteDetails.referenceProject || !!quoteDetails.quotationNumber || !!quoteDetails.category || (quoteDetails.leadTime && quoteDetails.leadTime !== '90 Days') ||
            extractedData.length > 0 || quoteNotes.trim() !== '';

          return (
            <div className="flex flex-wrap items-center justify-between w-full mb-6">
              <div className="flex flex-wrap items-center gap-3">
                {mappedData.length > 0 && (
                  <>
            <button
              onClick={exportToExcel}
              className="px-4 py-2 bg-[#1a1c1e] whitespace-nowrap text-white border border-white/10 rounded-xl text-sm font-medium hover:bg-white/5 transition-colors flex items-center gap-2"
            >
              <Download className="w-4 h-4 text-green-400 shrink-0" />
              Export Excel
            </button>
            <button
              onClick={handleSaveClick}
              className="px-4 py-2 border border-white/10 whitespace-nowrap text-white rounded-xl text-sm font-medium hover:bg-white/5 transition-all flex items-center gap-2"
            >
               <Save className="w-4 h-4 text-white shrink-0" />
              Save
            </button>
            <button
              onClick={exportToPDF}
              disabled={isExportingPDF}
              className="px-4 py-2 bg-primary whitespace-nowrap text-white rounded-xl text-sm font-bold hover:bg-primary/90 transition-all flex items-center gap-2 shadow-lg shadow-primary/20"
            >
              {isExportingPDF ? (
                 <RefreshCw className="w-4 h-4 text-white animate-spin shrink-0" />
              ) : (
                 <Printer className="w-4 h-4 text-white shrink-0" />
              )}
              {isExportingPDF ? 'Printing...' : 'Print'}
            </button>
            {isCarpetOrLinen && (
              <button
                onClick={() => setRoundRateAED(!roundRateAED)}
                className={`px-4 py-2 border rounded-xl text-sm font-medium whitespace-nowrap transition-colors flex items-center gap-2 ${roundRateAED ? 'bg-primary/20 text-primary border-primary/30' : 'bg-[#1a1c1e] text-slate-300 border-white/10 hover:bg-white/5'}`}
              >
                <RefreshCw className={`w-4 h-4 shrink-0 ${roundRateAED ? 'animate-spin-slow' : ''}`} />
                {roundRateAED ? 'Rate Rounding ON' : 'Round Rate AED'}
              </button>
            )}
            {!isCarpetOrLinen && !quoteDetails.isPO && !quoteDetails.isDO && (
              <>
              </>
            )}
                  </>
                )}
              </div>
              
              {hasAnyData && (
                <button
                  onClick={() => {
                    setMappedData([]);
                    clearQuotesFromDB();
                    setExtractedData([]);
                    setClientInfo({ name: '', email: '', billingAddress: '', sameAsBilling: true, deliveryAddress: '', sameAsDelivery: false });
                    setQuoteDetails({ quotationNumber: '', quotationDate: new Date().toISOString().slice(0, 10), referenceProject: '', category: '', leadTime: '' });
                    setPricingSettings({
                       discountType: 'Fixed',
                       discountValue: 0,
                       shipping: 0,
                       roundUpTo50: true,
                       roundGrandTotal: true
                    });
                    setRoundedColumns({ 'Unit Price AED': true });
                    setQuoteNotes('');
                    const newId = `sq-${Date.now()}`;
                    setSupplierQuoteHeaders([{ id: newId, supplier: '', currency: 'USD', exchangeRate: '3.70', margin: '120' }]);
                    fetchExchangeRate(newId, 'USD', true);
                    localStorage.removeItem('artizio_quote_id');
                    localStorage.removeItem('artizio_client_info');
                    localStorage.removeItem('artizio_quote_details');
                    localStorage.removeItem('artizio_pricing');
                    localStorage.removeItem('artizio_quote_notes');
                    localStorage.removeItem('artizio_supplier_quote_headers');
                    localStorage.removeItem('artizio_extracted_data');
                    localStorage.setItem('artizio_rounded_columns', JSON.stringify({ 'Unit Price AED': true }));
                  }}
                  className="px-4 py-2 bg-red-500/10 whitespace-nowrap text-red-400 border border-red-500/20 rounded-xl text-sm font-medium hover:bg-red-500/20 transition-colors flex items-center gap-2 ml-auto"
                >
                  <Trash2 className="w-4 h-4 shrink-0" />
                  Clear All
                </button>
              )}
            </div>
          );
        })()}
      </div>
      </div>

      <div className="pb-8 w-full">
        <div className="max-w-[1540px] mx-auto w-full px-6 md:px-10">
        <div className="flex flex-col items-center justify-start w-full pt-8 px-1">
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 w-full mb-6 shrink-0 relative z-20">
              
              {/* Client Information */}
              <div className="bg-[#1a1c1e] border border-white/5 rounded-2xl p-6">
                <h3 className="text-white font-bold mb-6">{quoteDetails.isPO ? 'Vendor Information' : 'Client Information'}</h3>
                
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">{quoteDetails.isPO ? 'Vendor Name' : 'Client Name'}</label>
                    <CustomCombobox
                      value={clientInfo.name}
                      onChange={(newName) => setClientInfo({...clientInfo, name: capitalizeWords(newName)})}
                      options={quoteDetails.isPO ? (suppliers ? suppliers.map(s => s.name) : []) : uniqueClientNames}
                      placeholder={quoteDetails.isPO ? "Search or enter vendor..." : "Search or enter client..."}
                      icon={<Search className="w-4 h-4" />}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">Email</label>
                    <input
                      type="email"
                      className="w-full px-3 py-2 text-sm bg-app-base border border-white/10 rounded-lg focus:ring-primary focus:border-primary outline-none text-white placeholder:text-slate-500"
                      placeholder="client@example.com"
                      value={clientInfo.email}
                      onChange={(e) => setClientInfo({...clientInfo, email: e.target.value})}
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-medium text-slate-400">Billing Address <span className="text-slate-500">(invoice)</span></label>
                      <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer group">
                        <div className={`w-4 h-4 flex items-center justify-center rounded-full border-2 transition-colors ${clientInfo.sameAsBilling ? 'border-blue-500' : 'border-slate-500 group-hover:border-slate-400'}`}>
                          {clientInfo.sameAsBilling && <Check className="w-2.5 h-2.5 text-blue-500 stroke-[4]" />}
                        </div>
                        <input
                          type="checkbox"
                          className="hidden"
                          checked={clientInfo.sameAsBilling}
                          onChange={(e) => setClientInfo({...clientInfo, sameAsBilling: e.target.checked})}
                        />
                        Same as Reference/Project
                      </label>
                    </div>
                    <textarea
                      className="w-full px-3 py-2 text-sm bg-app-base border border-white/10 rounded-lg focus:ring-primary focus:border-primary outline-none text-white placeholder:text-slate-500 min-h-[60px] resize-y"
                      placeholder="Billing address if different from above"
                      value={clientInfo.sameAsBilling ? quoteDetails.referenceProject : clientInfo.billingAddress}
                      onChange={(e) => setClientInfo({...clientInfo, billingAddress: e.target.value})}
                      disabled={clientInfo.sameAsBilling}
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="block text-xs font-medium text-slate-400">Delivery Address <span className="text-slate-500">(invoice)</span></label>
                      <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer group">
                        <div className={`w-4 h-4 flex items-center justify-center rounded-full border-2 transition-colors ${clientInfo.sameAsDelivery ? 'border-blue-500' : 'border-slate-500 group-hover:border-slate-400'}`}>
                          {clientInfo.sameAsDelivery && <Check className="w-2.5 h-2.5 text-blue-500 stroke-[4]" />}
                        </div>
                        <input
                          type="checkbox"
                          className="hidden"
                          checked={clientInfo.sameAsDelivery}
                          onChange={(e) => setClientInfo({...clientInfo, sameAsDelivery: e.target.checked})}
                        />
                        Same as Billing address
                      </label>
                    </div>
                    <textarea
                      className="w-full px-3 py-2 text-sm bg-app-base border border-white/10 rounded-lg focus:ring-primary focus:border-primary outline-none text-white placeholder:text-slate-500 min-h-[60px] resize-y"
                      placeholder="Delivery / shipping address"
                      value={clientInfo.sameAsDelivery ? (clientInfo.sameAsBilling ? quoteDetails.referenceProject : clientInfo.billingAddress) : clientInfo.deliveryAddress}
                      onChange={(e) => setClientInfo({...clientInfo, deliveryAddress: e.target.value})}
                      disabled={clientInfo.sameAsDelivery}
                    />
                  </div>
                </div>
              </div>

              {/* Quote Details */}
              <div className="bg-[#1a1c1e] border border-white/5 rounded-2xl p-6">
                <h3 className="text-white font-bold mb-6">{quoteDetails.isDO ? 'DN Details' : quoteDetails.isPO ? 'PO Details' : quoteDetails.isInvoice ? 'Invoice Details' : 'Quote Details'}</h3>
                
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">{quoteDetails.isDO ? 'DN Number' : quoteDetails.isPO ? 'PO Number' : quoteDetails.isInvoice ? 'Invoice Number' : 'Quotation Number'}</label>
                    <input
                      type="text"
                      className="w-full px-3 py-2 text-sm bg-app-base border border-white/10 rounded-lg focus:ring-primary focus:border-primary outline-none text-white placeholder:text-slate-500"
                      placeholder={quoteDetails.isDO ? "e.g. DN-070526-01" : quoteDetails.isPO ? "e.g. PO-070526-01" : "e.g. RK-070526-01"}
                      value={quoteDetails.quotationNumber}
                      onChange={(e) => {
                        manualQuoteRef.current = true;
                        setQuoteDetails({...quoteDetails, quotationNumber: e.target.value});
                      }}
                    />
                    <p className="text-[10px] text-slate-500 mt-1">Auto-generated from client name — edit freely</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">{quoteDetails.isDO ? 'DN Date' : quoteDetails.isPO ? 'PO Date' : quoteDetails.isInvoice ? 'Invoice Date' : 'Quotation Date'}</label>
                    <CustomDatePicker
                      value={quoteDetails.quotationDate}
                      onChange={(v) => setQuoteDetails({...quoteDetails, quotationDate: v})}
                      className="w-full px-3 py-2 text-sm bg-app-base border border-white/10 rounded-lg focus-within:border-primary text-white transition-colors"
                      placeholder="Select date"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">Reference / Project</label>
                    <CustomCombobox
                      value={quoteDetails.referenceProject}
                      onChange={(newProjectName) => {
                        const capitalizedName = capitalizeWords(newProjectName);
                        setQuoteDetails({...quoteDetails, referenceProject: capitalizedName});
                        const matchingProject = (projects || []).find(p => p.name === capitalizedName);
                        if (matchingProject && matchingProject.clientName && !clientInfo.name) {
                            setClientInfo(prev => ({...prev, name: matchingProject.clientName}));
                        }
                      }}
                      options={uniqueProjectNames}
                      placeholder="Search or enter project..."
                      icon={<Search className="w-4 h-4" />}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">Category</label>
                    <div className={`w-full px-3 py-2 text-sm bg-app-base/50 border border-white/10 rounded-lg max-w-xs min-h-[38px] flex items-center ${quoteDetails.category ? 'text-white' : 'text-slate-500'}`}>
                      {quoteDetails.category || 'Auto Updated'}
                    </div>
                  </div>
                  {!quoteDetails.isDO && !quoteDetails.isPO && (
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">Lead Time</label>
                    <input
                      type="text"
                      className="w-full px-3 py-2 text-sm bg-app-base border border-white/10 rounded-lg focus:ring-primary focus:border-primary outline-none text-white placeholder:text-slate-500"
                      placeholder="e.g. 8-10 weeks"
                      value={quoteDetails.leadTime}
                      onChange={(e) => setQuoteDetails({...quoteDetails, leadTime: e.target.value})}
                    />
                  </div>
                  )}
                </div>
              </div>

            </div>

            {/* Upload Supplier Quotes */}
            {!quoteDetails.isPO && !quoteDetails.isInvoice && !quoteDetails.isDO && (
              <div className="bg-[#1a1c1e] border border-white/5 rounded-2xl p-6 w-full mb-8 shrink-0 relative z-20">
                <h3 className="text-white font-bold mb-6 flex items-center gap-2">
                  <Upload className="w-4 h-4" />
                  Upload Supplier Quotes
                </h3>
                
                {supplierQuoteHeaders.map((header, index) => {
                  // Every supplier-quote dropdown lists all suppliers. (Previously, quotes
                  // after the first were filtered to the first supplier's category, which
                  // hid valid suppliers.)
                  const availableSuppliers = (suppliers || []);

                  return (
                  <div key={header.id} className="border border-white/10 rounded-xl p-5 mb-4 relative">
                    <div className="absolute top-0 left-0 bg-white/5 px-3 py-1 rounded-br-xl rounded-tl-xl text-[10px] font-bold tracking-wider text-slate-400">
                      SUPPLIER QUOTE #{index + 1}
                      {header.supplier && (suppliers || []).find(s => s.name === header.supplier)?.code ? ` - ${(suppliers || []).find(s => s.name === header.supplier)?.code}` : ''}
                    </div>
                    
                    <div className="grid grid-cols-1 md:grid-cols-12 gap-4 mt-6 mb-4">
                      <div className="md:col-span-3">
                        <label className="block text-xs font-medium text-slate-400 mb-1">Supplier</label>
                        <CustomSelect
                          searchable
                          className="w-full bg-app-base border border-white/10 rounded-lg py-2 px-3 focus:ring-primary focus:border-primary outline-none"
                          value={header.supplier}
                          onChange={(value) => handleSupplierChange(header.id, value)}
                          options={[
                            { value: '', label: 'No supplier' },
                            ...availableSuppliers.map(s => ({ value: s.name, label: `${s.name} ${s.code ? `(${s.code})` : ''}` }))
                          ]}
                        />
                      </div>
                      <div className="md:col-span-2">
                        <label className="block text-xs font-medium text-slate-400 mb-1">Supplier Code</label>
                        <input 
                          type="text"
                          readOnly
                          value={header.supplier ? ((suppliers || []).find(s => s.name === header.supplier)?.code || 'N/A') : ''}
                          className="w-full px-3 py-2 text-sm bg-white/5 border border-white/10 rounded-lg outline-none text-slate-400 cursor-not-allowed"
                          placeholder="e.g. BAM"
                        />
                      </div>
                      <div className="md:col-span-2">
                        <label className="block text-xs font-medium text-slate-400 mb-1">Currency</label>
                        <CustomSelect
                          className="w-full bg-app-base border border-white/10 rounded-lg py-2 px-3 focus:ring-primary focus:border-primary outline-none"
                          value={header.currency}
                          onChange={(value) => updateSupplierQuoteHeader(header.id, 'currency', value)}
                          options={[
                            { value: 'USD', label: 'USD' },
                            { value: 'AED', label: 'AED' },
                            { value: 'EUR', label: 'EUR' }
                          ]}
                        />
                      </div>
                      <div className="md:col-span-3 relative">
                        <label className="block text-xs font-medium text-slate-400 mb-1">Exchange Rate (to AED)</label>
                        <div className="relative">
                          <input
                            type="text"
                            className="w-full px-3 py-2 pr-10 text-sm bg-app-base border border-white/10 rounded-lg focus:ring-primary focus:border-primary outline-none text-white"
                            value={header.exchangeRate}
                            onChange={(e) => updateSupplierQuoteHeader(header.id, 'exchangeRate', e.target.value)}
                            onBlur={(e) => {
                              const val = parseFloat(e.target.value);
                              if (!isNaN(val)) updateSupplierQuoteHeader(header.id, 'exchangeRate', val.toFixed(2));
                            }}
                          />
                          <button 
                            onClick={() => fetchExchangeRate(header.id, header.currency)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-white rounded"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      <div className="md:col-span-2">
                        <label className="block text-xs font-medium text-slate-400 mb-1">Margin %</label>
                        <input
                          type="text"
                          className="w-full px-3 py-2 text-sm bg-app-base border border-white/10 rounded-lg focus:ring-primary focus:border-primary outline-none text-white"
                          value={header.margin}
                          onChange={(e) => updateSupplierQuoteHeader(header.id, 'margin', e.target.value)}
                        />
                      </div>
                    </div>

                    <div 
                      className={`w-full border-2 border-dashed rounded-xl bg-white/[0.02] p-4 flex items-center gap-4 transition-all ${
                        header.supplier 
                          ? 'border-white/10 hover:bg-white/[0.04] hover:border-primary/50 cursor-pointer group' 
                          : 'border-white/5 opacity-50 cursor-not-allowed'
                      }`}
                      onClick={() => {
                        if (!header.supplier) {
                          toast.error("Please select a supplier first");
                          return;
                        }
                        setActiveSourceId(header.id);
                        fileInputRef.current?.click();
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!header.supplier) {
                          toast.error("Please select a supplier first");
                          return;
                        }
                        const file = e.dataTransfer.files?.[0];
                        if (file) {
                          setActiveSourceId(header.id);
                          const fakeEvent = { target: { files: [file] } } as any;
                          handleFileUpload(fakeEvent);
                        }
                      }}
                    >
                      <div className="w-10 h-10 bg-white/5 rounded-lg flex items-center justify-center shrink-0">
                        <FileText className={`w-5 h-5 transition-colors ${header.supplier ? 'text-slate-400 group-hover:text-primary' : 'text-slate-500'}`} />
                      </div>
                      <div className="flex-1">
                        <h4 className="text-sm font-medium text-white mb-0.5">
                          {header.supplier ? `Click to choose file for ${header.supplier}` : 'Click to choose file'}
                          {header.supplier && (suppliers || []).find(s => s.name === header.supplier)?.code ? ` (${(suppliers || []).find(s => s.name === header.supplier)?.code})` : ''}
                        </h4>
                        <p className="text-xs text-slate-500">
                          {header.supplier ? 'PNG, JPG, PDF, Excel (.xlsx, .xls)' : 'Select a supplier above to upload quotes'}
                        </p>
                      </div>
                    </div>
                  </div>
                  );
                })}
                
                <input 
                  type="file" 
                  ref={fileInputRef}
                  onClick={(e) => (e.target as any).value = null}
                  onChange={handleFileUpload}
                  className="sr-only"
                />

                <button 
                  onClick={addSupplierQuoteHeader}
                  className="text-sm font-medium flex items-center gap-1.5 text-primary hover:text-primary-hover transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  Add Supplier Quote
                </button>
              </div>
            )}
            
          </div>

        {mappedData.length === 0 && (
          <div className="w-full flex justify-center mb-8">
            <button 
              onClick={addRow}
              className="py-3 px-6 bg-white/5 hover:bg-white/10 rounded-xl text-slate-300 transition-colors flex items-center gap-2 border border-white/10"
            >
              <Plus className="w-4 h-4" /> Start Adding Manually
            </button>
          </div>
        )}

        {mappedData.length > 0 && supplierQuoteHeaders.map((header) => {
          const headerData = mappedData.filter(row => {
            const rowSourceId = row.sourceId || supplierQuoteHeaders[0].id;
            return rowSourceId === header.id;
          });
          if (headerData.length === 0) return null;
          
          return (
            <div key={header.id} id={`quote-table-${header.id}`} className="bg-[#1a1c1e] border border-white/5 rounded-3xl overflow-hidden shadow-2xl flex flex-col w-full mb-8">
              <div className="bg-app-base px-6 py-4 border-b border-white/5 flex items-center justify-between gap-3">
                 <div className="flex items-center gap-3">
                   <h3 className="font-bold text-white tracking-wide">{header.supplier || 'Unspecified Supplier'}</h3>
                   <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-white/10 text-slate-300 uppercase tracking-wider">{header.currency}</span>
                 </div>
                 <div className="flex items-center gap-2 flex-wrap justify-end">
                   <button
                     onClick={() => setColumnsLocked(!columnsLocked)}
                     className={`px-3 py-1.5 border rounded-lg text-xs font-semibold whitespace-nowrap transition-colors flex items-center gap-2 ${columnsLocked ? 'bg-primary/20 text-primary border-primary/30' : 'bg-[#1a1c1e] text-slate-300 border-white/10 hover:bg-white/5'}`}
                   >
                     {columnsLocked ? <Lock className="w-3.5 h-3.5 shrink-0" /> : <Unlock className="w-3.5 h-3.5 shrink-0" />}
                     {columnsLocked ? 'Columns Locked' : 'Lock Columns'}
                   </button>
                   {!isCarpetOrLinen && !quoteDetails.isPO && !quoteDetails.isDO && (
                     <button
                       onClick={() => setPricingSettings(prev => ({ ...prev, roundUpTo50: !prev.roundUpTo50 }))}
                       className={`px-3 py-1.5 border rounded-lg text-xs font-semibold whitespace-nowrap transition-colors flex items-center gap-2 ${pricingSettings.roundUpTo50 ? 'bg-primary/20 text-primary border-primary/30' : 'bg-[#1a1c1e] text-slate-300 border-white/10 hover:bg-white/5'}`}
                       title="Round up Unit Price AED to next nearest 100"
                     >
                       Adjusted Unit Price AED
                     </button>
                   )}
                   <button onClick={() => {
                     setMappedData(prev => prev.filter(row => row.sourceId !== header.id));
                   }} className="px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-500 rounded-lg text-xs font-semibold transition-colors flex items-center gap-2">
                     <Trash2 className="w-3 h-3" /> Clear Rows
                   </button>
                 </div>
              </div>
              <div className="overflow-auto max-h-[75vh] min-h-[300px] relative">
                <Reorder.Group as="table" axis="y" values={headerData} onReorder={(newOrder) => handleReorder(header.id, newOrder)} className="w-full text-left border-collapse min-w-[1200px]">
                  <thead>
                    <tr>
                      {currentStandardFields.map(f => (
                        <th 
                          key={f} 
                        className={`sticky top-0 bg-[#222524] z-10 py-3 px-4 border-b border-white/10 font-semibold text-slate-300 text-sm relative group ${['Unit Price USD', 'Margin %', 'Unit Price AED', 'Qty', 'Total', 'Size'].includes(f) ? 'text-center' : 'text-left'} ${['Material', 'Specification'].includes(f) ? 'pl-4 text-left' : ''} ${f.includes('Unit Price') ? 'whitespace-normal leading-tight min-w-[80px]' : 'whitespace-nowrap'}`}
                        style={{ width: colWidths[f] ? `${colWidths[f]}px` : 'auto', minWidth: colWidths[f] ? `${colWidths[f]}px` : 'auto' }}
                      >
                        {f === 'Unit Price USD' ? (
                          <div className="flex items-center justify-center gap-1 group/header">
                            <div>{isCarpetOrLinen ? <>Rate</> : <>Unit Price<br/>{displayCurrency}</>}</div>
                          </div>
                        ) : f === 'Unit Price AED' ? (
                          <div className="flex items-center justify-center gap-1 group/header">
                            <div>{isCarpetOrLinen ? <>Rate AED</> : <>Unit Price<br/>AED</>}</div>
                          </div>
                        ) : f === 'Image' ? (
                          <div className="flex items-center gap-2">
                            Image
                            <button 
                              onClick={() => setHideImageInPrint(!hideImageInPrint)}
                              className="text-slate-400 hover:text-white transition-colors"
                              title={hideImageInPrint ? "Show in print" : "Hide in print"}
                            >
                              {hideImageInPrint ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                            </button>
                          </div>
                        ) : ['Remarks', 'Material', 'Specification'].includes(f) ? (
                          <div className="flex items-center gap-2">
                            {f}
                            <button 
                              onClick={() => {
                                if (f === 'Remarks') setHideRemarksInPrint(!hideRemarksInPrint);
                                if (f === 'Material') setHideMaterialInPrint(!hideMaterialInPrint);
                                if (f === 'Specification') setHideSpecificationInPrint(!hideSpecificationInPrint);
                              }}
                              className="text-slate-400 hover:text-white transition-colors"
                              title={
                                (f === 'Remarks' ? hideRemarksInPrint : f === 'Material' ? hideMaterialInPrint : hideSpecificationInPrint) 
                                ? "Show in print" : "Hide in print"
                              }
                            >
                              {(f === 'Remarks' ? hideRemarksInPrint : f === 'Material' ? hideMaterialInPrint : hideSpecificationInPrint) 
                                ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                            </button>
                          </div>
                        ) : (
                          f
                        )}
                        {(f === 'Area') && (
                          <span className="inline-flex items-center ml-1 font-normal select-none">
                            <span className="text-slate-500 text-[10px]">
                              {/* Unit shown just for reference in editor, but user wants it renamed to just Area */}
                            </span>
                          </span>
                        )}
                        {!columnsLocked && (
                          <div 
                            className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary z-20 touch-none transition-colors"
                            onMouseDown={(e) => startResizing(f, e as any)}
                          />
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                  {headerData.map((row, idx) => {
                    if (row.isSubHeading) {
                      return (
                        <Reorder.Item 
                          as="tbody" 
                          key={row.id} 
                          value={row} 
                          className="border-b border-white/5 bg-white/[0.04] group hover:bg-white/[0.06] transition-colors cursor-grab active:cursor-grabbing"
                        >
                          <tr>
                            <td colSpan={currentStandardFields.length} className="p-2.5 text-center leading-none">
                               <input
                                 type="text"
                                 value={row.subHeadingText || ''}
                                 onChange={(e) => updateField(row.id, 'subHeadingText', e.target.value)}
                                 className="w-full bg-transparent text-base font-normal text-white focus:outline-none placeholder-slate-500 text-center"
                                 placeholder="Sub Heading"
                               />
                            </td>
                          </tr>
                          <tr>
                            <td colSpan={currentStandardFields.length} className="p-1 border-t border-white/[0.02]">
                              <div className="flex items-center justify-end gap-1 px-4">
                               <span className="text-[10px] text-slate-500 font-medium uppercase tracking-wider mr-auto">Actions</span>
                                 <button
                                    onClick={() => insertRow(mappedData.findIndex(r => r.id === row.id), header.id)}
                                    className="p-1 px-2 text-emerald-500 hover:bg-emerald-500/10 rounded-lg transition-colors bg-white/5 flex items-center gap-1.5 text-xs font-semibold"
                                    title="Add Row Above"
                                 >
                                    <Plus className="w-3 h-3" />
                                    Add Row
                                 </button>
                                 <button
                                    onClick={() => insertSubHeading(mappedData.findIndex(r => r.id === row.id), header.id)}
                                    className="p-1 px-2 text-blue-400 hover:bg-blue-500/10 rounded-lg transition-colors bg-white/5 flex items-center gap-1.5 text-xs font-semibold"
                                    title="Add Sub Heading Above"
                                 >
                                    <Type className="w-3 h-3" />
                                    Add Header
                                 </button>
                                 <button
                                   onClick={() => removeRow(row.id)}
                                   className="p-1 px-2 text-red-400 hover:bg-red-500/10 rounded-lg transition-colors bg-white/5 flex items-center gap-1.5 text-xs font-semibold"
                                   title="Delete Sub Heading"
                                 >
                                    <Trash2 className="w-3 h-3" />
                                    Delete
                                 </button>
                              </div>
                            </td>
                          </tr>
                        </Reorder.Item>
                      );
                    }

                    return (
                      <Reorder.Item 
                        as="tbody" 
                        key={row.id} 
                        value={row} 
                        id={`quote-row-${row.id}`}
                        onClick={() => setFocusedRowId(row.id)}
                        className={`border-t border-b transition-colors group cursor-grab active:cursor-grabbing ${highlightRowId === row.id ? 'border-primary bg-primary/10 ring-2 ring-primary/50' : `border-white/10 hover:bg-white/[0.02] ${focusedRowId === row.id ? 'bg-white/[0.03]' : ''}`}`}
                      >
                        <tr>
                          {currentStandardFields.map(field => (
                            <td key={`${row.id}-${field}`} className={`p-2 align-top relative ${['Material', 'Specification'].includes(field) ? 'pl-4' : ''}`}>
                              {field === 'Image' ? (
                                <div 
                                   className="mx-auto block relative outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-lg overflow-hidden w-12 h-12 group/img" 
                                   tabIndex={0}
                                >
                                  {row.image && (row.image.startsWith('data:image') || row.image.startsWith('http')) ? (
                                    <div 
                                      className="w-12 h-12 cursor-pointer rounded-lg overflow-hidden bg-white/5 mx-auto border border-white/10 flex items-center justify-center transition-colors relative"
                                      onClick={() => handleImagePasteClick(row.id)}
                                    >
                                      <img src={row.image} alt={row['Item Code'] || 'Product'} className="max-w-full max-h-full object-contain" />
                                    </div>
                                  ) : (
                                    <div className="w-12 h-12 flex-shrink-0 cursor-pointer rounded-lg bg-white/[0.02] border border-white/5 mx-auto flex flex-col items-center justify-center text-slate-600 transition-colors hover:text-slate-400" onClick={() => handleImagePasteClick(row.id)}>
                                      <ImageIcon className="w-4 h-4 mb-1" />
                                      <span className="text-[7px] uppercase tracking-wider text-center px-1">Img</span>
                                    </div>
                                  )}
                                  
                                  <div className="absolute inset-0 bg-black/60 opacity-0 group-hover/img:opacity-100 flex flex-col items-center justify-center gap-0.5 transition-opacity z-10 rounded-lg backdrop-blur-[1px]">
                                    <button
                                      onClick={(e) => { e.stopPropagation(); handleImageUploadClick(row.id); }}
                                      className="p-0.5 text-white hover:text-primary transition-colors bg-white/10 hover:bg-white/20 rounded cursor-pointer w-[80%] flex justify-center"
                                      title="Upload Image"
                                    >
                                      <Upload className="w-3.5 h-3.5 text-slate-300" />
                                    </button>
                                    <button
                                      onClick={async (e) => {
                                        e.stopPropagation();
                                        handleImagePasteClick(row.id);
                                      }}
                                      className="p-0.5 text-white hover:text-primary transition-colors bg-white/10 hover:bg-white/20 rounded cursor-pointer w-[80%] flex justify-center"
                                      title="Paste Image from Clipboard"
                                    >
                                      <ClipboardPaste className="w-3.5 h-3.5 text-slate-300" />
                                    </button>
                                  </div>
                                </div>
                              ) : field === 'Total' ? (
                                <div className="w-full bg-app-base/30 border border-white/5 rounded-md p-1.5 text-sm font-bold text-[#cba36b] text-center min-h-[32px] flex items-center justify-center tabular-nums">
                                  {parseFloat(String(row[field] || '0')).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </div>
                              ) : field === 'Unit Price AED' ? (
                                <AutoResizeTextarea
                                  value={row[field]}
                                  onChange={(e: any) => updateField(row.id, field, e.target.value)}
                                  className="w-full bg-transparent border border-transparent hover:border-white/10 focus:border-primary focus:bg-black/20 rounded-md p-1.5 text-sm text-slate-300 transition-colors text-center font-medium"
                                  placeholder="Price AED"
                                />
                              ) : (
                                <AutoResizeTextarea
                                  value={row[field]}
                                  onChange={(e: any) => updateField(row.id, field, e.target.value)}
                                  onBlur={() => {
                                    if (field === 'Unit Price USD') {
                                      const cleanedValue = String(row[field] || '').replace(/[^0-9.-]/g, '');
                                      const parsedNum = parseFloat(cleanedValue);
                                      if (!isNaN(parsedNum)) {
                                        updateField(row.id, field, parsedNum.toFixed(2));
                                      }
                                    }
                                  }}
                                  className={`w-full bg-transparent border border-transparent hover:border-white/10 focus:border-primary focus:bg-black/20 rounded-md p-1.5 text-sm text-slate-300 transition-colors ${['Unit Price USD', 'Margin %', 'Qty'].includes(field) ? 'text-center' : ''}`}
                                  placeholder={`Enter ${field.toLowerCase()}`}
                                />
                              )}
                            </td>
                          ))}
                        </tr>
                        <tr>
                          <td colSpan={currentStandardFields.length} className="p-1 border-t border-white/[0.02]">
                            <div className="flex items-center justify-end gap-1 px-4">
                               <span className="text-[10px] text-slate-500 font-medium uppercase tracking-wider mr-auto">Actions</span>
                               <button
                                  onClick={() => insertRow(mappedData.findIndex(r => r.id === row.id), header.id)}
                                  className="p-1 px-2 text-emerald-500 hover:bg-emerald-500/10 rounded-lg transition-colors bg-white/5 flex items-center gap-1.5 text-xs font-semibold"
                                  title="Add Row Above"
                                  onPointerDown={(e) => e.stopPropagation()}
                               >
                                  <Plus className="w-3 h-3" />
                                  Add Row
                               </button>
                               <button
                                  onClick={() => insertSubHeading(mappedData.findIndex(r => r.id === row.id), header.id)}
                                  className="p-1 px-2 text-blue-400 hover:bg-blue-500/10 rounded-lg transition-colors bg-white/5 flex items-center gap-1.5 text-xs font-semibold"
                                  title="Add Sub Heading Above"
                                  onPointerDown={(e) => e.stopPropagation()}
                               >
                                  <Type className="w-3 h-3" />
                                  Add Header
                               </button>
                               <button
                                  onClick={() => duplicateRow(row.id)}
                                  className="p-1 px-2 mb-1 mt-1 text-purple-400 hover:bg-purple-500/10 rounded-lg transition-colors bg-white/5 flex items-center gap-1.5 text-xs font-semibold"
                                  title="Duplicate Row"
                                  onPointerDown={(e) => e.stopPropagation()}
                               >
                                  <Copy className="w-3 h-3" />
                                  Duplicate
                               </button>
                               <button
                                 onClick={() => removeRow(row.id)}
                                 className="p-1 px-2 text-red-400 hover:bg-red-500/10 rounded-lg transition-colors bg-white/5 flex items-center gap-1.5 text-xs font-semibold"
                                 title="Delete Row"
                                 onPointerDown={(e) => e.stopPropagation()}
                               >
                                 <Trash2 className="w-3 h-3" />
                                 Delete
                               </button>
                            </div>
                          </td>
                        </tr>
                      </Reorder.Item>
                    );
                  })}
              </Reorder.Group>
              <div className="flex justify-end p-3 border-t border-white/5">
                <button
                  onClick={() => insertRowAtEndOfSupplier(header.id)}
                  className="p-2 px-4 text-emerald-500 hover:bg-emerald-500/10 rounded-xl transition-colors bg-white/5 border border-white/10 flex items-center gap-2 text-sm font-bold shadow-sm"
                  title="Add Row to End"
                >
                  <Plus className="w-4 h-4" />
                  Add Row
                </button>
              </div>
            </div>
          </div>
        )})}

      {mappedData.length > 0 && (
        <div className="mt-8 flex flex-col gap-6 max-w-full">
          {/* Summary Widget */}
          {!quoteDetails.isDO && (
            <div className="flex flex-col items-end gap-3">
               <div className="w-full md:w-96 bg-app-surface rounded-3xl border border-white/5 p-6 shadow-sm flex flex-col gap-3">
                <div className="flex justify-between items-center text-sm">
                   <span className="text-slate-400">Subtotal</span>
                   <span className="text-white font-bold tabular-nums">{quoteDetails.isPO ? displayCurrency : 'AED'} {(() => {
                        const subtotalAED = mappedData.reduce((sum, row) => sum + (parseFloat(String(row['Total']).replace(/[^0-9.-]/g, '')) || 0), 0);
                        return subtotalAED.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                   })()}</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                   <span className="text-slate-400">Discount <span className="opacity-50">(% / AED)</span></span>
                   <div className="flex items-center gap-2">
                       <input 
                         type="number" 
                         className="w-16 px-2 py-1 bg-app-base rounded-lg border border-white/10 text-right text-white focus:border-primary outline-none text-xs hide-spin-button" 
                         value={pricingSettings.discountType === '%' ? pricingSettings.discountValue : 0}
                         onChange={e => setPricingSettings({...pricingSettings, discountType: '%', discountValue: parseFloat(e.target.value) || 0})}
                       /> 
                       <span className="text-slate-500">/</span> 
                       <input 
                         type="number" 
                         className="w-20 px-2 py-1 bg-app-base rounded-lg border border-white/10 text-right text-white focus:border-primary outline-none text-xs hide-spin-button" 
                         value={pricingSettings.discountType === 'AED' ? pricingSettings.discountValue : 0}
                         onChange={e => setPricingSettings({...pricingSettings, discountType: 'AED', discountValue: parseFloat(e.target.value) || 0})}
                       />
                   </div>
                </div>
                <div className="flex justify-between items-center text-sm">
                   <span className="text-slate-400">After Discount</span>
                   <span className="text-white font-bold tabular-nums">{quoteDetails.isPO ? displayCurrency : 'AED'} {(() => {
                        const subtotalAED = mappedData.reduce((sum, row) => sum + (parseFloat(String(row['Total']).replace(/[^0-9.-]/g, '')) || 0), 0);
                        const discount = pricingSettings.discountType === '%' ? (subtotalAED * pricingSettings.discountValue / 100) : pricingSettings.discountValue;
                        return (subtotalAED - discount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                   })()}</span>
                </div>
                {!quoteDetails.isPO && (
                  <>
                    <div className="flex justify-between items-center text-sm">
                       <label className="flex items-center gap-2 cursor-pointer select-none">
                         <input
                           type="checkbox"
                           checked={pricingSettings.vatEnabled !== false}
                           onChange={e => setPricingSettings(prev => ({ ...prev, vatEnabled: e.target.checked }))}
                           className="w-4 h-4 accent-primary cursor-pointer"
                           title="Include VAT in this quote / invoice"
                         />
                         <span className="text-slate-400">VAT ({quoteDefaults.defaultVat}%)</span>
                       </label>
                       <span className="text-white font-bold tabular-nums">AED {(() => {
                            const subtotalAED = mappedData.reduce((sum, row) => sum + (parseFloat(String(row['Total']).replace(/[^0-9.-]/g, '')) || 0), 0);
                            const discount = pricingSettings.discountType === '%' ? (subtotalAED * pricingSettings.discountValue / 100) : pricingSettings.discountValue;
                            const afterDiscount = subtotalAED - discount;
                            const vat = (pricingSettings.vatEnabled === false) ? 0 : afterDiscount * ((parseFloat(quoteDefaults.defaultVat) || 5) / 100);
                            return vat.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                       })()}</span>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                       <span className="text-slate-400">Shipping</span>
                       <div className="flex items-center gap-2 text-slate-400 font-bold text-xs">
                          AED <input type="number" className="w-24 px-2 py-1 bg-app-base rounded-lg border border-white/10 text-right text-white focus:border-primary outline-none text-xs hide-spin-button" value={pricingSettings.shipping} onChange={e => setPricingSettings({...pricingSettings, shipping: parseFloat(e.target.value) || 0})} />
                       </div>
                    </div>
                  </>
                )}
                <div className="pt-4 mt-1 border-t border-white/10 flex justify-between items-center text-lg font-bold">
                    <div className="flex flex-col">
                      <div className="flex items-center gap-2">
                        <span className="text-white">Grand Total</span>
                        <button 
                          onClick={() => setPricingSettings(prev => ({ ...prev, roundGrandTotal: !prev.roundGrandTotal }))}
                          className={`p-1 rounded-md transition-colors ${pricingSettings.roundGrandTotal ? 'bg-primary/20 text-primary' : 'text-slate-500 hover:text-slate-300'}`}
                          title="Round off to next 100"
                        >
                          <ArrowUpRight className={`w-4 h-4`} />
                        </button>
                      </div>
                    </div>
                    <div className="flex flex-col items-end">
                   <span className="text-[#cba36b] tabular-nums">{quoteDetails.isPO ? displayCurrency : 'AED'} {(() => {
                        const subtotalAED = mappedData.reduce((sum, row) => sum + (parseFloat(String(row['Total']).replace(/[^0-9.-]/g, '')) || 0), 0);
                        const discount = pricingSettings.discountType === '%' ? (subtotalAED * pricingSettings.discountValue / 100) : pricingSettings.discountValue;
                        const afterDiscount = subtotalAED - discount;
                        const vat = (pricingSettings.vatEnabled === false) ? 0 : afterDiscount * ((parseFloat(quoteDefaults.defaultVat) || 5) / 100);
                            let total = afterDiscount + (quoteDetails.isPO ? 0 : vat) + (quoteDetails.isPO ? 0 : pricingSettings.shipping);
                            if (pricingSettings.roundGrandTotal) {
                              total = Math.ceil(total / 100) * 100;
                            }
                            return total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                   })()}</span>
                   {pricingSettings.roundGrandTotal && (
                     <span className="text-[10px] text-slate-500 font-normal italic mt-0.5">(Rounded Off)</span>
                   )}
                   </div>
                </div>

                {quoteDetails.isInvoice && (
                   <>
                     <div className="pt-4 mt-3 border-t border-white/5 flex justify-between items-center text-sm">
                        <span className="text-slate-400">Advance Paid</span>
                        <div className="flex items-center gap-2 text-slate-400 font-bold text-xs">
                          AED <input 
                                type="number" 
                                className="w-24 px-2 py-1 bg-app-base rounded-lg border border-white/10 text-right text-white focus:border-primary outline-none text-xs hide-spin-button" 
                                value={quoteDetails.advancePayment || 0} 
                                onChange={e => setQuoteDetails({...quoteDetails, advancePayment: parseFloat(e.target.value) || 0})} 
                              />
                        </div>
                     </div>
                     <div className="pt-3 mt-3 border-t border-white/5 flex justify-between items-center text-base font-bold bg-[#cba36b]/5 -mx-6 px-6 pb-2 rounded-b-3xl">
                        <span className="text-[#cba36b] mt-2">Balance Due</span>
                        <span className="text-[#cba36b] tabular-nums mt-2">AED {(() => {
                           const subtotalAED = mappedData.reduce((sum, row) => sum + (parseFloat(String(row['Total']).replace(/[^0-9.-]/g, '')) || 0), 0);
                           const discount = pricingSettings.discountType === '%' ? (subtotalAED * pricingSettings.discountValue / 100) : pricingSettings.discountValue;
                           const afterDiscount = subtotalAED - discount;
                           const vat = (pricingSettings.vatEnabled === false) ? 0 : afterDiscount * ((parseFloat(quoteDefaults.defaultVat) || 5) / 100);
                           let total = afterDiscount + vat + pricingSettings.shipping;
                           if (pricingSettings.roundGrandTotal) {
                             total = Math.ceil(total / 100) * 100;
                           }
                           return (total - Number(quoteDetails.advancePayment)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                        })()}</span>
                     </div>
                   </>
                )}
             </div>
             
            <div className="w-full md:w-96 text-right px-2 flex justify-end gap-8" style={(quoteDetails.isPO) ? { display: 'none' } : undefined}>
                <div>
                  <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1">TOTAL QTY</p>
                  <p className="text-slate-400 font-medium text-sm">{(() => {
                      const totalQty = mappedData.reduce((sum, row) => {
                         if (row.isSubHeading) return sum;
                         const qtyOrArea = parseFloat(String(row[isCarpetOrLinen ? 'Area' : 'Qty'] || '0').replace(/[^0-9.]/g, '')) || 0;
                         return sum + qtyOrArea;
                      }, 0);
                      return totalQty.toLocaleString('en-US', { maximumFractionDigits: 2 });
                  })()}{isCarpetOrLinen ? ' sqm' : ''}</p>
                </div>
                <div>
                  <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1">SUPPLIER COST (EXCL. MARGIN)</p>
                  <p className="text-slate-400 font-medium text-sm">{supplierQuoteHeaders[0]?.currency || 'USD'} {(() => {
                      const cost = mappedData.reduce((sum, row) => {
                         if (row.isSubHeading) return sum;
                         const unitCost = parseFloat(String(row['Unit Price USD'] || '0').replace(/[^0-9.]/g, '')) || 0;
                         const qtyOrArea = parseFloat(String(row[isCarpetOrLinen ? 'Area' : 'Qty'] || '0').replace(/[^0-9.]/g, '')) || 0;
                         return sum + (unitCost * qtyOrArea);
                      }, 0);
                      return cost.toLocaleString('en-US', {minimumFractionDigits: 2});
                  })()}</p>
                </div>
             </div>
          </div>
          )}

          {/* Notes, Terms & Signatures */}
          <div className="bg-app-surface rounded-3xl border border-white/5 p-8 shadow-sm">
             <h3 className="text-sm font-bold text-white mb-4">Notes</h3>
             <textarea 
                className="w-full bg-app-base border border-white/10 rounded-xl p-4 text-sm text-slate-300 min-h-[100px] outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-all placeholder:text-slate-600 resize-none"
                value={quoteNotes}
                onChange={e => setQuoteNotes(e.target.value)}
                placeholder="Add notes (e.g., Lights Quote)..."
             />
          </div>

          <div className="bg-app-surface rounded-3xl border border-white/5 p-8 shadow-sm">
             <div className="flex justify-between items-end mb-4">
                <h3 className="text-sm font-bold text-white">{quoteDetails.isPO ? 'Purchase Order Terms & Conditions' : quoteDetails.isDO ? 'Delivery Note Terms & Conditions' : 'Terms & Conditions'}</h3>
                <span className="text-xs text-slate-500">Editing here only affects this quote. Change defaults in Settings.</span>
             </div>
             <textarea 
                className="w-full bg-app-base border border-white/10 rounded-xl p-4 text-sm font-mono text-slate-300 min-h-[220px] outline-none focus:border-primary focus:ring-1 focus:ring-primary/50 transition-all whitespace-pre-wrap resize-none"
                value={quoteTerms}
                onChange={e => setQuoteTerms(e.target.value)}
             />
          </div>

          {!quoteDetails.isPO && (
            <div className="bg-app-surface rounded-3xl border border-white/5 p-8 shadow-sm mb-12">
               <h3 className="text-sm font-bold text-white mb-10">Signatures</h3>
               <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
                  <div>
                     <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-14">CLIENT SIGNATURE</p>
                     <div className="border-t border-white/20 pt-2 mb-8"><p className="text-xs text-slate-500">Authorized Signature</p></div>
                     <div className="border-t border-white/20 pt-2 mb-8"><p className="text-xs text-slate-500">Name:</p></div>
                     <div className="border-t border-white/20 pt-2"><p className="text-xs text-slate-500">Date:</p></div>
                  </div>
                  <div>
                     <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-14">ON BEHALF OF ARTIZIO BESPOKE FURNITURE</p>
                     <div className="border-t border-white/20 pt-2"><p className="text-xs text-slate-500">Authorised Signatory</p></div>
                  </div>
               </div>
             </div>
          )}
        </div>
      )}
      </div>

      {/* Save Quote Modal */}
      <AnimatePresence>
        {isSaveModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setIsSaveModalOpen(false)}></div>
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#1a1c1e] max-w-md w-full relative z-10 rounded-2xl border border-white/10 shadow-2xl flex flex-col"
            >
              <div className="p-6 border-b border-white/5 flex items-center justify-between bg-[#1f2224]">
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                  <Save className="w-5 h-5 text-primary" />
                  Save Quote
                </h2>
                <button 
                  onClick={() => setIsSaveModalOpen(false)}
                  className="p-2 hover:bg-white/5 rounded-lg text-slate-400 hover:text-white transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-6 space-y-6 relative z-10">
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 text-white cursor-pointer group">
                    <input
                      type="radio"
                      name="saveMode"
                      value="new"
                      checked={saveMode === 'new'}
                      onChange={() => setSaveMode('new')}
                      className="accent-primary"
                    />
                    <span className="group-hover:text-primary transition-colors">New Project</span>
                  </label>
                  <label className="flex items-center gap-2 text-white cursor-pointer group">
                    <input
                      type="radio"
                      name="saveMode"
                      value="existing"
                      checked={saveMode === 'existing'}
                      onChange={() => setSaveMode('existing')}
                      className="accent-primary"
                    />
                    <span className="group-hover:text-primary transition-colors">Existing Project</span>
                  </label>
                </div>

                {saveMode === 'new' ? (
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-2">Project Name</label>
                    <input
                      type="text"
                      className="w-full bg-app-base border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/50"
                      placeholder="Enter new project name"
                      value={newSaveProjectName}
                      onChange={(e) => setNewSaveProjectName(e.target.value)}
                      autoFocus
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-2">Select Project</label>
                    <CustomSelect
                      className="w-full bg-app-base border border-white/10 rounded-xl py-3 px-4 text-sm focus:ring-primary focus:border-primary outline-none"
                      value={selectedSaveProjectId}
                      onChange={(value) => setSelectedSaveProjectId(value)}
                      placeholder="Select a project..."
                      options={(projects || []).map(p => ({
                        value: p.id,
                        label: `${p.name} ${p.clientName ? `(${p.clientName})` : ''}`
                      }))}
                    />
                  </div>
                )}
              </div>
              <div className="px-6 py-4 border-t border-white/5 bg-[#1a1c1e] flex justify-end gap-3">
                <button
                  onClick={() => setIsSaveModalOpen(false)}
                  className="px-4 py-2 text-sm font-medium text-slate-300 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveQuote}
                  className="px-6 py-2 bg-primary text-white text-sm font-medium rounded-xl hover:bg-primary-hover shadow-lg shadow-primary/20 transition-colors"
                >
                  Save
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Serial Number Confirm Modal */}
      <AnimatePresence>
        {showSerialPrompt && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowSerialPrompt(false)}></div>
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-[#1a1c1e] max-w-md w-full relative z-10 rounded-2xl border border-white/10 shadow-2xl flex flex-col"
            >
              <div className="p-6 border-b border-white/5 flex items-center justify-between bg-[#1f2224]">
                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                  <Save className="w-5 h-5 text-primary" />
                  Change Serial Number?
                </h2>
                <button 
                  onClick={() => setShowSerialPrompt(false)}
                  className="p-2 hover:bg-white/5 rounded-lg text-slate-400 hover:text-white transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="p-6 space-y-4">
                <p className="text-sm text-slate-300 leading-relaxed">
                  You are saving a quote/invoice that has already been saved. Do you want to change/increment the quote serial number?
                </p>
                <div className="bg-app-base p-3 rounded-xl border border-white/5 flex flex-col gap-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-slate-400">Current Serial Number:</span>
                    <span className="text-white font-mono">{quoteDetails.quotationNumber || 'Pending'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">Next Serial Number:</span>
                    <span className="text-primary font-mono font-bold">{getNextSerialNumber(quoteDetails.quotationNumber)}</span>
                  </div>
                </div>
              </div>
              <div className="px-6 py-4 border-t border-white/5 bg-[#1a1c1e] flex justify-end gap-3">
                <button
                  onClick={() => {
                    setShowSerialPrompt(false);
                    handleSaveQuote(pendingSaveParams?.opProjectId, true, true);
                  }}
                  className="px-4 py-2 text-sm font-medium border border-white/10 text-slate-300 hover:text-white hover:bg-white/5 rounded-xl transition-colors"
                >
                  Save as New Document
                </button>
                <button
                  onClick={() => {
                    setShowSerialPrompt(false);
                    handleSaveQuote(pendingSaveParams?.opProjectId, true, false);
                  }}
                  className="px-5 py-2 bg-primary text-white text-sm font-medium rounded-xl hover:bg-primary-hover shadow-lg shadow-primary/20 transition-colors"
                >
                  Overwrite Existing Revision
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Mapping Modal */}
      <AnimatePresence>
        {isMappingModalOpen && (
          <div className="fixed inset-0 z-50 overflow-y-auto flex justify-center items-start pt-10 pb-20 px-4 sm:pt-20 custom-scrollbar">
            <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setIsMappingModalOpen(false)}></div>
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              className="bg-[#1a1c1e] border border-white/10 rounded-[32px] p-6 md:p-8 max-w-6xl w-full z-10 shadow-2xl flex flex-col relative"
            >
              <div className="flex items-center justify-between mb-6 shrink-0">
                <div>
                  <h2 className="text-2xl font-bold text-white">Map Columns</h2>
                  <p className="text-slate-400 text-sm mt-1">Check the preview, then match the supplier's Excel headers to your standard system columns.</p>
                </div>
                <button 
                  onClick={() => setIsMappingModalOpen(false)}
                  className="p-2 rounded-full hover:bg-white/5 text-slate-400 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex flex-col lg:flex-row gap-6">
                {/* LEFT: Excel Preview */}
                <div className="lg:w-1/2 shrink-0">
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-2">
                    <FileText className="w-4 h-4 text-primary" />
                    Uploaded File Preview
                    <span className="text-slate-500 font-normal normal-case tracking-normal ml-1">— scroll to see all columns</span>
                  </p>
                  <div className="border border-white/10 rounded-2xl overflow-hidden bg-white/[0.02]">
                    <div className="overflow-auto max-h-[55vh] preview-scroll">
                      <table className="text-xs border-collapse w-max min-w-full">
                        <thead className="sticky top-0 z-10">
                          <tr>
                            {headers.filter(h => String(h || "").trim() !== "").map((header, idx) => (
                              <th key={`ph-${idx}`} className="bg-[#2a2d2f] text-left font-bold text-white px-3 py-2 border-b border-r border-white/10 whitespace-nowrap min-w-[110px]">
                                {header}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {extractedData.slice(0, 6).map((row, rIdx) => (
                            <tr key={`pr-${rIdx}`} className="even:bg-white/[0.015]">
                              {headers.filter(h => String(h || "").trim() !== "").map((header, cIdx) => {
                                const val = row[header];
                                const display = val === undefined || val === null ? '' : String(val);
                                const isImageData = display.startsWith('data:image');
                                return (
                                  <td key={`pc-${rIdx}-${cIdx}`} className="text-slate-300 px-3 py-2 border-b border-r border-white/5 whitespace-nowrap min-w-[110px] max-w-[220px] truncate" title={isImageData ? '[image]' : display}>
                                    {isImageData ? <span className="text-slate-500 italic">[image]</span> : (display.length > 40 ? display.slice(0, 40) + '…' : display)}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                          {extractedData.length === 0 && (
                            <tr><td className="text-slate-500 px-3 py-4 text-center" colSpan={headers.length || 1}>No preview rows available.</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  {extractedData.length > 6 && (
                    <p className="text-xs text-slate-500 mt-2">Showing first 6 of {extractedData.length} rows.</p>
                  )}
                </div>

                {/* RIGHT: Mapping Controls */}
                <div className="lg:w-1/2 flex flex-col">
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Column Mapping</p>
                  <div className="flex flex-col space-y-3 overflow-y-auto max-h-[55vh] pr-1 custom-scrollbar">
                {headers.filter(h => String(h || "").trim() !== "").map((header, idx) => (
                  <div key={`${header}-${idx}`} className="flex flex-col sm:flex-row items-start sm:items-center gap-3 p-3 rounded-2xl bg-white/[0.02] border border-white/5 hover:border-white/10 transition-colors relative">
                    <div className="flex-1 flex items-center justify-between w-full">
                      <div className="min-w-0">
                        <p className="text-xs text-slate-400 mb-0.5">Supplier Sheet Header</p>
                        <p className="font-semibold text-white text-sm truncate" title={header}>{header}</p>
                      </div>
                      
                      {/* Rounded Check Mark Option to Ignore Column */}
                      <div className="shrink-0 flex items-center pr-1">
                        <button
                          type="button"
                          onClick={() => {
                            const isCurrentlyIgnored = !mapping[header];
                            if (isCurrentlyIgnored) {
                              setMapping(prev => ({ ...prev, [header]: 'Item Code' }));
                            } else {
                              setMapping(prev => ({ ...prev, [header]: '' }));
                            }
                          }}
                          className="flex items-center gap-2 group cursor-pointer focus:outline-none"
                        >
                          <div className={`w-5 h-5 flex items-center justify-center rounded-full border-2 transition-all duration-200 ${!mapping[header] ? 'border-primary bg-primary/20 scale-105 shadow-sm' : 'border-white/20 group-hover:border-white/40 bg-transparent'}`}>
                            {!mapping[header] && <Check className="w-3 h-3 text-primary stroke-[4]" />}
                          </div>
                          <span className="text-xs font-semibold text-slate-400 group-hover:text-white transition-colors">Ignore</span>
                        </button>
                      </div>
                    </div>
                    <div className="shrink-0 flex items-center justify-center w-6 text-slate-600 hidden sm:flex">
                      →
                    </div>
                    <div className="flex-1 w-full sm:w-auto">
                      <p className="text-xs text-slate-400 mb-1 sm:hidden">Maps To System Column</p>
                      <CustomSelect
                        value={mapping[header] || ''}
                        onChange={(value) => setMapping(prev => ({ ...prev, [header]: value }))}
                        className="w-full bg-app-base border border-white/10 rounded-xl py-2 px-3 text-sm focus:border-primary outline-none"
                        placeholder="Ignore Column"
                        options={MAPPABLE_FIELDS
                          .filter(f => {
                            if (f === 'Image' && hideImageInPrint) return false;
                            if (['Total', 'Margin %'].includes(f)) return false;
                            if (isCarpetOrLinen && f === 'Unit Price AED') return false;
                            return true;
                          })
                          .map(f => {
                            let label = f;
                            if (f === 'Unit Price USD') label = isCarpetOrLinen ? `Rate` : `Unit Price ${displayCurrency}`;
                            if (f === 'Unit Price AED') label = 'Unit Price AED';
                            return { value: f, label };
                          })
                          .filter(Boolean) as { value: string, label: string }[]
                        }
                      />
                    </div>
                  </div>
                ))}
                  </div>
                </div>
              </div>
              
              <div className="mt-6 pt-6 border-t border-white/5 shrink-0 flex items-center justify-end gap-4">
                <button 
                  onClick={() => setIsMappingModalOpen(false)}
                  className="px-6 py-3 rounded-xl text-slate-300 font-medium hover:bg-white/5 transition-colors"
                >
                  Cancel
                </button>
                <button 
                  onClick={applyMapping}
                  className="px-8 py-3 bg-primary text-white rounded-xl font-bold hover:bg-primary-hover shadow-lg shadow-primary/20 transition-all flex items-center gap-2"
                >
                  <Check className="w-5 h-5" />
                  Extract Data
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <input 
        type="file" 
        ref={imageInputRef}
        onChange={handleImageFileChange}
        className="sr-only"
      />

      {/* NATIVE PRINT PREVIEW OVERLAY */}
      <div id="print-container" className="hidden print:block absolute top-0 left-0 w-[100vw] h-max min-h-[100vh] bg-white text-black text-[12px] font-sans !leading-snug z-[99999]" style={{ margin: 0, padding: 0 }}>
        <style>{`
          @font-face {
            font-family: 'Grift';
            src: url('/fonts/grift-medium.ttf') format('truetype');
            font-weight: 500;
            font-style: normal;
          }
          @page { size: A4; margin: 10mm 10mm; }
          body { font-family: 'Grift', sans-serif !important; background: white; -webkit-print-color-adjust: exact; print-color-adjust: exact; margin: 0; padding: 0; }
          * { font-family: 'Grift', sans-serif !important; box-sizing: border-box; }
          .print-table th, .print-table td { border-bottom: 0.5px solid #dcdcdc; padding: 8px 6px; vertical-align: middle; }
          .print-header { background-color: #4a2c2a !important; color: white !important; font-weight: bold; }
          .subheading-row { background-color: #f8f1f1 !important; font-weight: bold; font-style: italic; page-break-after: avoid; break-after: avoid; page-break-inside: avoid; break-inside: avoid; }
          .page-break { page-break-inside: avoid; break-inside: avoid; }
        `}</style>

        {(quoteDetails.isPO ? supplierQuoteHeaders.filter(h => mappedData.some(r => r.sourceId === h.id)) : [{ id: 'all' } as any]).map((pageHeader, pageIndex, pageArr) => {
           const currentSupplierName = quoteDetails.isPO ? pageHeader.supplier : clientInfo.name;
           const pageData = quoteDetails.isPO 
             ? mappedData.filter(r => r.isSubHeading || r.sourceId === pageHeader.id)
             : mappedData;

           return (
           <div key={pageHeader.id} style={{ pageBreakAfter: pageIndex < pageArr.length - 1 ? 'always' : 'auto' }}>
             <table className="w-full" style={{ borderSpacing: 0 }}>
          <thead>
            <tr><td><div className="h-6"></div></td></tr>
          </thead>
          <tbody>
            <tr><td style={{ padding: '0 40px' }}>
              {/* Header */}
              <div className="flex justify-between items-start mb-6">
                <div>
                  {reportLogo ? (
                    <img src={reportLogo} alt="Logo" className="h-[75px] mb-1 object-contain" />
                  ) : (
                    <h1 className="text-4xl font-bold text-[#6a221c] leading-none mb-1">{companyInfo?.name || 'Artizio'}</h1>
                  )}
                </div>
                <div className="text-right">
                   <h2 className="text-3xl font-bold text-[#6a221c] uppercase tracking-wide">
                     {quoteDetails.isDO ? 'Delivery Note' : quoteDetails.isPO ? 'Purchase Order' : quoteDetails.isInvoice ? 'Tax Invoice' : 'Quotation'}
                   </h2>
                   <p className="text-sm font-medium mt-1">{quoteDetails.isDO ? 'DN' : quoteDetails.isPO ? 'PO' : quoteDetails.isInvoice ? 'Invoice' : 'Quote'} # {quoteDetails.quotationNumber || 'Pending'}</p>
                   {quoteDetails.isInvoice && companyInfo?.trn && (
                     <p className="text-sm font-medium mt-1">Company TRN: {companyInfo.trn}</p>
                   )}
                </div>
              </div>
              
              <div className="border-t-[1.5px] border-[#6a221c] w-full mb-6 relative"></div>
              
              {/* Client & Quote Info */}
              <div className="flex justify-between mb-8 text-[12px]">
                 <div className="w-1/2 pr-4">
                   <table className="w-full">
                     <tbody>
                        <tr><td className="w-16 font-bold py-1 text-[#6a221c] uppercase">{quoteDetails.isPO ? 'TO' : 'BILL TO'}</td><td className="py-1"></td></tr>
                        <tr><td colSpan={2} className="py-1 text-[16px] font-bold pb-2">{currentSupplierName}</td></tr>
                        {quoteDetails.isPO ? (
                          (() => {
                            const supplierObj = (suppliers || []).find(s => s.name.toLowerCase() === currentSupplierName.toLowerCase());
                            const sEmail = supplierObj?.email || clientInfo.email || '';
                            const sPhone = supplierObj?.phone || '';
                            const sAddr = supplierObj?.address || clientInfo.billingAddress || '';
                            return (
                              <>
                                {sAddr && <tr><td className="whitespace-nowrap w-px font-bold py-1 pr-2 align-top text-[#6a221c]">Address:</td><td className="py-1 align-top whitespace-pre-wrap">{sAddr}</td></tr>}
                                {sEmail && <tr><td className="whitespace-nowrap w-px font-bold py-1 pr-2 align-top text-[#6a221c]">Email:</td><td className="py-1 align-top whitespace-pre-wrap">{sEmail}</td></tr>}
                                {sPhone && <tr><td className="whitespace-nowrap w-px font-bold py-1 pr-2 align-top text-[#6a221c]">Phone:</td><td className="py-1 align-top whitespace-pre-wrap">{sPhone}</td></tr>}
                              </>
                            );
                          })()
                        ) : (
                          <>
                            {clientInfo.email && <tr><td className="whitespace-nowrap w-px font-bold py-1 pr-2 align-top text-[#6a221c]">Email:</td><td className="py-1 align-top">{clientInfo.email}</td></tr>}
                            {quoteDetails.isInvoice ? (
                              <>
                                {(clientInfo.sameAsBilling ? quoteDetails.referenceProject : clientInfo.billingAddress) && <tr><td className="whitespace-nowrap w-px font-bold py-1 pr-2 align-top text-[#6a221c]">Billing Address:</td><td className="py-1 align-top whitespace-pre-wrap">{clientInfo.sameAsBilling ? quoteDetails.referenceProject : clientInfo.billingAddress}</td></tr>}
                                {(clientInfo.sameAsDelivery ? (clientInfo.sameAsBilling ? quoteDetails.referenceProject : clientInfo.billingAddress) : clientInfo.deliveryAddress) && <tr><td className="whitespace-nowrap w-px font-bold py-1 pr-2 align-top text-[#6a221c]">Delivery Address:</td><td className="py-1 align-top whitespace-pre-wrap">{clientInfo.sameAsDelivery ? (clientInfo.sameAsBilling ? quoteDetails.referenceProject : clientInfo.billingAddress) : clientInfo.deliveryAddress}</td></tr>}
                              </>
                            ) : (
                              (clientInfo.sameAsBilling ? quoteDetails.referenceProject : clientInfo.billingAddress) && <tr><td className="whitespace-nowrap w-px font-bold py-1 pr-2 align-top text-[#6a221c]">Address:</td><td className="py-1 align-top whitespace-pre-wrap">{clientInfo.sameAsBilling ? quoteDetails.referenceProject : clientInfo.billingAddress}</td></tr>
                            )}
                          </>
                        )}
                     </tbody>
                   </table>
                 </div>
                 <div className="w-1/2 pl-4">
                   <table className="w-auto ml-auto text-left">
                     <tbody>
                        {quoteDetails.isPO && (
                          <>
                            <tr><td className="font-bold py-1 text-[#6a221c] uppercase">&nbsp;</td><td className="py-1"></td></tr>
                            <tr><td colSpan={2} className="py-1 text-[16px] font-bold pb-2">&nbsp;</td></tr>
                          </>
                        )}
                        <tr><td className="font-bold py-1 text-right pr-4 text-[#6a221c]">Date:</td><td className="py-1 whitespace-nowrap min-w-[120px]">{(() => {
                            const [year, month, day] = quoteDetails.quotationDate.split('-');
                            return `${day || ''}-${month || ''}-${year || ''}`;
                        })()}</td></tr>
                        <tr><td className="font-bold py-1 text-right pr-4 text-[#6a221c]">Reference/Project:</td><td className="py-1 max-w-[200px] break-words">{quoteDetails.referenceProject || '-'}</td></tr>
                        {quoteDetails.isPO ? (
                           <>
                             {companyInfo?.name && <tr><td className="font-bold py-1 text-right pr-4 text-[#6a221c] align-top">Company:</td><td className="py-1 max-w-[200px] break-words whitespace-pre-wrap">{companyInfo.name}</td></tr>}
                             {companyInfo?.trn && <tr><td className="font-bold py-1 text-right pr-4 text-[#6a221c]">TRN:</td><td className="py-1 max-w-[200px] break-words">{companyInfo.trn}</td></tr>}
                           </>
                        ) : quoteDetails.isDO ? null : (
                           <tr><td className="font-bold py-1 text-right pr-4 text-[#6a221c]">Lead Time:</td><td className="py-1 max-w-[200px] break-words">{quoteDetails.leadTime || '-'}</td></tr>
                        )}
                     </tbody>
                   </table>
                 </div>
              </div>

              {/* Items Table */}
              <table className="w-full print-table mb-8 text-left border-collapse text-[11px]">
                <thead>
                  <tr className="print-header text-[11px]">
                     <th className="w-[5%] text-center">#</th>
                     {(!hideImageInPrint || !hideRemarksInPrint) && <th className="w-[12%] text-center">{!hideImageInPrint ? 'Image' : 'Remarks'}</th>}
                     <th className={quoteDetails.isDO ? "w-[20%]" : (isCarpetOrLinen ? "w-[16%]" : "w-[18%]")}>Item Code & Size</th>
                     {(!hideMaterialInPrint || !hideSpecificationInPrint) && <th className={quoteDetails.isDO ? "w-[50%]" : (isCarpetOrLinen ? "w-[26%]" : "w-[36%]")} style={{ paddingLeft: '16px', textAlign: 'left' }}>Material & Specification</th>}
                     {!quoteDetails.isDO && (
                       <>
                         <th className="w-[10%] text-right">{quoteDetails.isPO ? `Unit Price (${displayCurrency})` : 'Unit Price'}</th>
                         {isCarpetOrLinen && <th className="w-[10%] text-right">{quoteDetails.isPO ? `Rate (Sqft) (${displayCurrency})` : 'Rate (Sqft) AED'}</th>}
                       </>
                     )}
                     {isCarpetOrLinen ? (
                       <>
                         <th className="w-[5%] text-center">Qty</th>
                         <th className="w-[5%] text-center">Area</th>
                       </>
                     ) : (
                       <th className="w-[6%] text-center">Qty</th>
                     )}
                     {!quoteDetails.isDO && <th className="w-[10%] text-right">Amount</th>}
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    let slNoCounter = 1;
                    const showImageColumn = !hideImageInPrint || !hideRemarksInPrint;
                    const showMaterialColumn = !hideMaterialInPrint || !hideSpecificationInPrint;
                    const totalCols = 1 + (showImageColumn ? 1 : 0) + 1 + (showMaterialColumn ? 1 : 0) + 1 + (isCarpetOrLinen ? 1 : 0) + 1 + 1;

                    return pageData.map((row, i) => {
                       if (row.isSubHeading) {
                         // Ensure we don't print empty subheadings for a supplier by checking if there's any item after it with this sourceId before next heading
                         if (quoteDetails.isPO) {
                           const subIdx = mappedData.findIndex(r => r.id === row.id);
                           const nextSubIdx = mappedData.findIndex((r, idx) => idx > subIdx && r.isSubHeading);
                           const itemsInBetween = mappedData.slice(subIdx + 1, nextSubIdx === -1 ? mappedData.length : nextSubIdx);
                           if (!itemsInBetween.some(r => r.sourceId === pageHeader.id)) return null;
                         }
                         return (
                           <tr key={`head_${i}`} className="subheading-row">
                              <td colSpan={12} className="font-bold text-[#6a221c] py-2 text-center text-[10px] uppercase tracking-wider">{row.subHeadingText}</td>
                           </tr>
                         );
                       }
                       const currentSlNo = row['Sl No'] || slNoCounter++;
                       
                       const header = supplierQuoteHeaders.find(h => h.id === row.sourceId) || supplierQuoteHeaders[0];
                       const supplierObj = (suppliers || []).find(s => s.name === header?.supplier);
                       const supplierCode = supplierObj?.code ? `${supplierObj.code}-` : '';

                       let displayCode = String(row['Item Code'] || '-');
                       if (supplierCode && !displayCode.startsWith(supplierCode)) {
                           displayCode = `${supplierCode}${displayCode}`;
                       }
                       displayCode = displayCode.toUpperCase();

                       let unitPrice = parseFloat(String((quoteDetails.isPO ? row['Unit Price USD'] : row['Unit Price AED']) || '0').replace(/[^0-9.-]/g, ''));
                       if (isCarpetOrLinen && roundRateAED) {
                         unitPrice = Math.ceil(unitPrice);
                       }
                       const rateSqft = parseFloat(String(row['Rate (Sqft) AED'] || '0').replace(/[^0-9.-]/g, ''));
                       const qty = isCarpetOrLinen ? (row['Area'] || '') : (row['Qty'] || 1);
                       const total = parseFloat(String(row['Total'] || '0').replace(/[^0-9.-]/g, ''));

                       return (
                         <tr key={`row_${i}`} className="page-break">
                            <td className="text-center align-top">{currentSlNo}</td>
                            {showImageColumn && (
                              <td className="text-center py-2 align-top">
                               {!hideImageInPrint && row['image'] && row['image'].startsWith('data:image') && (
                                 <img src={row['image']} alt="" className={`mx-auto block ${(!hideRemarksInPrint && row['Remarks']) ? 'mb-1' : ''}`} style={{ maxHeight: '80px', maxWidth: '80px', objectFit: 'contain' }} />
                               )}
                               {!hideRemarksInPrint && row['Remarks'] && (
                                 <div className="text-gray-500 italic text-[9px] leading-tight break-words text-left">
                                   {(() => {
                                     const remVal = String(row['Remarks'] || '');
                                     const remParts = remVal.split('\n');
                                     return (
                                       <div className="flex flex-col gap-0.5 text-left font-normal text-slate-500">
                                         {remParts.map((part, idx) => {
                                            if (idx === 0) {
                                              return <span key={idx} className="text-gray-500 italic text-[9px] leading-tight">{part}</span>;
                                            }
                                            return (
                                              <span key={idx} className="text-gray-400 italic text-[8.5px] pl-1.5 block text-left" style={{ color: '#888888', fontStyle: 'italic', paddingLeft: '6px' }}>
                                                {part}
                                              </span>
                                            );
                                         })}
                                       </div>
                                     );
                                   })()}
                                 </div>
                               )}
                              </td>
                            )}
                          <td className="align-top">
                            <div className="font-bold text-[#333] mb-1">
                              {(() => {
                                const rawCode = String(row['Item Code'] || '');
                                if (!rawCode) return '-';
                                const codeParts = rawCode.split('\n');
                                return (
                                  <div className="flex flex-col gap-0.5 text-left">
                                    {codeParts.map((part, idx) => {
                                      let formattedPart = part;
                                      if (supplierCode && !formattedPart.startsWith(supplierCode)) {
                                          formattedPart = `${supplierCode}${formattedPart}`;
                                      }
                                      formattedPart = formattedPart.toUpperCase();
                                      if (idx === 0) {
                                        return <span key={idx} className="font-bold text-[#333]">{formattedPart}</span>;
                                      }
                                      return (
                                        <span key={idx} className="text-gray-400 italic font-normal text-[9.5px] pl-2 block text-left" style={{ color: '#888888', fontStyle: 'italic', paddingLeft: '8px' }}>
                                          {formattedPart}
                                        </span>
                                      );
                                    })}
                                  </div>
                                );
                              })()}
                            </div>
                            <div className="text-[#6a221c] text-[10px] uppercase">
                              {(() => {
                                const sizeVal = String(row['Size'] || '');
                                if (!sizeVal) return '-';
                                const sizeParts = sizeVal.split('\n');
                                return (
                                  <div className="flex flex-col gap-0.5 text-left">
                                    {sizeParts.map((part, idx) => {
                                      if (idx === 0) {
                                        return <span key={idx} className="text-[#6a221c] text-[10px] uppercase">{part}</span>;
                                      }
                                      return (
                                        <span key={idx} className="text-gray-400 italic font-normal text-[9px] pl-2 block text-left" style={{ color: '#888888', fontStyle: 'italic', paddingLeft: '8px' }}>
                                          {part.toUpperCase()}
                                        </span>
                                      );
                                    })}
                                  </div>
                                );
                              })()}
                            </div>
                          </td>
                          <td className="align-top text-left" style={{ paddingLeft: '16px', textAlign: 'left' }}>
                            {!hideMaterialInPrint && (
                              <div className="text-[#333] mb-1 leading-snug text-left" style={{ textAlign: 'left' }}>
                                {(() => {
                                  const matVal = String(row['Material'] || '');
                                  if (!matVal) return '-';
                                  const matParts = matVal.split('\n');
                                  return (
                                    <div className="flex flex-col gap-0.5 text-left" style={{ textAlign: 'left' }}>
                                      {matParts.map((part, idx) => {
                                        const capitalizedPart = capitalizeFields(part);
                                        if (idx === 0) {
                                          return <span key={idx} className="text-[#333] leading-snug block text-left" style={{ textAlign: 'left' }}>{capitalizedPart}</span>;
                                        }
                                        return (
                                          <span key={idx} className="text-gray-400 italic font-normal text-[9.5px] block text-left" style={{ color: '#888888', fontStyle: 'italic', textAlign: 'left' }}>
                                            {capitalizedPart}
                                          </span>
                                        );
                                      })}
                                    </div>
                                  );
                                })()}
                              </div>
                            )}
                            {!hideSpecificationInPrint && (
                              <div className="text-left" style={{ textAlign: 'left' }}>
                                {(() => {
                                  const specVal = String(row['Specification'] || '');
                                  if (!specVal) return '';
                                  const singleLineSpec = specVal.split('\n').map(p => p.trim()).filter(Boolean).join(' - ');
                                  const capitalizedSpec = capitalizeFields(singleLineSpec);
                                  return (
                                    <span className="text-[#6a221c] text-[10px] leading-snug block font-medium text-left" style={{ textAlign: 'left' }}>
                                      {capitalizedSpec}
                                    </span>
                                  );
                                })()}
                              </div>
                            )}
                          </td>
                          {!quoteDetails.isDO && (
                            <>
                              <td className="text-right tabular-nums align-top">{unitPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                              {isCarpetOrLinen && (
                                <td className="text-right tabular-nums align-top">{rateSqft.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                              )}
                            </>
                          )}
                          {isCarpetOrLinen ? (
                            <>
                              <td className="text-center tabular-nums align-top">{row['Qty'] || 1}</td>
                              <td className="text-center tabular-nums align-top">{row['Area'] || ''}</td>
                            </>
                          ) : (
                            <td className="text-center tabular-nums align-top">{row['Qty'] || 1}</td>
                          )}
                          {!quoteDetails.isDO && (
                            <td className="text-right tabular-nums font-bold align-top">{total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                          )}
</tr>
                     );
                  })
                 })()}
                </tbody>
              </table>

              {/* Totals */}
              {!quoteDetails.isDO && (
              <div className="flex justify-end mb-12 w-full page-break">
                 <div className="w-[350px]">
                   {(() => {
                      const pdfSubtotal = pageData.reduce((sum, row) => sum + (parseFloat(String(row['Total']).replace(/[^0-9.-]/g, '')) || 0), 0);
                      const pdfDiscount = pricingSettings.discountType === '%' ? (pdfSubtotal * pricingSettings.discountValue / 100) : pricingSettings.discountValue;
                      const pdfAfterDiscount = pdfSubtotal - pdfDiscount;
                      const pdfVatPercent = parseFloat(quoteDefaults.defaultVat) || 5;
                      const pdfVat = (quoteDetails.isPO || pricingSettings.vatEnabled === false) ? 0 : (pdfAfterDiscount * (pdfVatPercent / 100));
                      const pdfShipping = quoteDetails.isPO ? 0 : pricingSettings.shipping;
                      let pdfGrandTotal = pdfAfterDiscount + pdfVat + pdfShipping;
                       if (pricingSettings.roundGrandTotal) {
                         pdfGrandTotal = Math.ceil(pdfGrandTotal / 100) * 100;
                       }
                      const formatNum = (num: number) => num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                      
                      return (
                       <table className="w-full text-right font-medium text-[12px]">
                         <tbody>
                            <tr className="bg-[#f8f1f1]">
                              <td className="py-2.5 px-4 text-[#6a221c]">{quoteDetails.isPO ? `Sub Total in ${displayCurrency}:` : 'Sub Total in AED:'}</td>
                              <td className="py-2.5 px-4 min-w-[100px]">{formatNum(pdfSubtotal)}</td>
                            </tr>
                            {(!quoteDetails.isPO && pdfDiscount > 0) && (
                            <tr>
                              <td className="py-2.5 px-4 text-[#6a221c]">Discount {pricingSettings.discountType === '%' && `(${pricingSettings.discountValue}%)`}:</td>
                              <td className="py-2.5 px-4 text-[#6a221c]">- AED {formatNum(pdfDiscount)}</td>
                            </tr>
                            )}
                            {!quoteDetails.isPO && pricingSettings.vatEnabled !== false && (
                            <tr>
                              <td className="py-2.5 px-4 text-[#6a221c]">VAT ({pdfVatPercent}%):</td>
                              <td className="py-2.5 px-4">AED {formatNum(pdfVat)}</td>
                            </tr>
                            )}
                            {(!quoteDetails.isPO && pricingSettings.shipping > 0) && (
                            <tr>
                              <td className="py-2.5 px-4 text-[#6a221c]">Shipping & Handling:</td>
                              <td className="py-2.5 px-4">AED {formatNum(pricingSettings.shipping)}</td>
                            </tr>
                            )}
                            <tr><td colSpan={2}><div className="border-t-2 border-[#6a221c] my-1"></div></td></tr>
                            <tr className="text-[#6a221c] font-bold text-[14px]">
                              <td className="py-3 px-4">
                                Grand Total:
                              </td>
                              <td className="py-3 px-4">
                                <div>{quoteDetails.isPO ? `${displayCurrency} ${formatNum(pdfSubtotal)}` : `AED ${formatNum(pdfGrandTotal)}`}</div>
                                {!quoteDetails.isPO && pricingSettings.roundGrandTotal && <div className="text-[10px] italic font-normal text-slate-500 leading-none mt-0.5">(Rounded Off)</div>}
                              </td>
                            </tr>
                            {quoteDetails.isInvoice && quoteDetails.advancePayment > 0 && (
                               <>
                                 <tr className="text-[#6a221c] font-medium text-[12px]">
                                   <td className="py-2.5 px-4 bg-[#6a221c]/5">Advance Payment Received:</td>
                                   <td className="py-2.5 px-4 bg-[#6a221c]/5">AED {formatNum(Number(quoteDetails.advancePayment))}</td>
                                 </tr>
                                 <tr className="text-[#6a221c] font-bold text-[13px] bg-[#6a221c]/10">
                                   <td className="py-3 px-4 box-border border-y-2 border-[#6a221c]">Balance Due:</td>
                                   <td className="py-3 px-4 box-border border-y-2 border-[#6a221c]">AED {formatNum(pdfGrandTotal - Number(quoteDetails.advancePayment))}</td>
                                 </tr>
                               </>
                            )}
                         </tbody>
                       </table>
                      );
                   })()}
                 </div>
              </div>
              )}

              {/* Bank Details */}
              {quoteDetails.isInvoice && (
                <div className="mb-8 p-4 border border-[#6a221c]/20 bg-[#6a221c]/[0.02] rounded-lg text-[11px] text-[#333] page-break mt-8">
                   <div className="font-bold text-[#6a221c] mb-2 text-[12px] pb-2 border-b border-[#6a221c]/20">BANK ACCOUNT DETAILS</div>
                   <div className="grid grid-cols-2 gap-2 mt-3 mb-4 border-b border-[#6a221c]/10 pb-4">
                     <div><span className="font-semibold text-slate-700">Bank Name:</span> {bankDetails?.bankName || '-'}</div>
                     <div><span className="font-semibold text-slate-700">Account Name:</span> {bankDetails?.accountName || '-'}</div>
                     <div><span className="font-semibold text-slate-700">Account No:</span> {bankDetails?.accountNumber || '-'}</div>
                     <div><span className="font-semibold text-slate-700">IBAN:</span> {bankDetails?.iban || '-'}</div>
                     <div><span className="font-semibold text-slate-700">SWIFT Code:</span> {bankDetails?.swift || '-'}</div>
                   </div>
                   {quoteDetails.paymentNote && (
                     <div className="text-[12px] font-medium text-[#6a221c]">
                       <span className="font-bold">Payment Note:</span> {quoteDetails.paymentNote}
                     </div>
                   )}
                </div>
              )}

              {/* Terms */}
              <div className="mb-16 font-medium text-[11px] whitespace-pre-wrap leading-relaxed text-[#333] page-break mt-6 bg-gray-50 border border-gray-100 p-4 rounded-lg shadow-sm">
                 <div className="font-bold text-[#6a221c] mb-3 text-[12px] pb-2 border-b border-gray-200">{quoteDetails.isPO ? 'PO TERMS' : quoteDetails.isInvoice ? 'INVOICE TERMS' : quoteDetails.isDO ? 'DELIVERY NOTE TERMS' : 'TERMS & CONDITIONS'}</div>
                 {quoteTerms.trim() || (quoteDetails.isPO ? (quoteDefaults?.purchaseOrderTerms || '') : quoteDetails.isInvoice ? (quoteDefaults?.invoiceTerms || '') : quoteDetails.isDO ? (quoteDefaults?.deliveryOrderTerms || '') : (quoteDefaults?.quotationTerms || ''))}
              </div>

              {/* Signatures */}
              {!quoteDetails.isPO && (
                <div className="flex justify-between w-full mt-24 page-break text-[11px]">
                   <div className="w-[40%]">
                      <div className="text-[11px] font-bold text-[#6a221c] mb-12">CLIENT SIGNATURE</div>
                      <div className="border-t border-[#6a221c] pt-2 font-medium">Authorized Signature</div>
                      <div className="border-t border-[#dcdcdc] pt-2 mt-8 text-gray-500">Name:</div>
                      <div className="border-t border-[#dcdcdc] pt-2 mt-8 text-gray-500">Date:</div>
                   </div>
                   <div className="w-[40%]">
                      <div className="text-[11px] font-bold text-[#6a221c] mb-12 text-right uppercase">On Behalf of Artizio Bespoke Furniture</div>
                      <div className="border-t border-[#6a221c] pt-2 font-medium flex justify-end">Authorised Signatory</div>
                   </div>
                </div>
              )}
            </td></tr>
          </tbody>
          <tfoot>
            <tr><td><div className="h-16"></div></td></tr>
          </tfoot>
        </table>
        </div>
        )})}

        {/* Footer info fixed to absolute bottom */}
        <div className="fixed bottom-0 left-0 w-full pb-2 px-10 bg-white z-[100000]" style={{ paddingLeft: '40px', paddingRight: '40px' }}>
           <div className="pt-4 border-t border-[#6a221c] text-[10px] text-[#6a221c] flex justify-between tracking-wide font-bold">
             <span>&#9742; +971501184539</span>
             <span>&#9993; info@artizio.ae</span>
             <span>&#8853; Near Samrat Metals & Wires. 26th St - Al Quoz Ind Area 4 - Dubai</span>
             <span>&#8853; www.artizio.ae</span>
           </div>
        </div>
      </div>
      </div>

      {/* Send Document Modal */}
      <AnimatePresence>
        {isSendModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => !isSending && setIsSendModalOpen(false)}></div>
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="relative w-full max-w-lg bg-[#1a1c1e] rounded-2xl shadow-2xl overflow-hidden border border-white/10"
            >
              <div className="p-6">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-3">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                    <h2 className="text-xl font-bold text-white">Send Document</h2>
                  </div>
                  <button onClick={() => !isSending && setIsSendModalOpen(false)} className="text-slate-400 hover:text-white transition-colors">
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-400 mb-1">Send Via</label>
                    <div className="flex gap-4">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="radio" checked={sendMethod === 'email'} onChange={() => setSendMethod('email')} className="accent-primary" />
                        <span className="text-white text-sm">Email (Native App)</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="radio" checked={sendMethod === 'whatsapp'} onChange={() => setSendMethod('whatsapp')} className="accent-primary" />
                        <span className="text-white text-sm">WhatsApp</span>
                      </label>
                    </div>
                  </div>

                  {sendMethod === 'email' && (
                    <div>
                      <label className="block text-sm font-medium text-slate-400 mb-1">Subject</label>
                      <input
                        type="text"
                        className="w-full bg-app-base text-white border border-white/10 rounded-xl px-4 py-2 focus:border-primary focus:outline-none"
                        value={sendSubject}
                        onChange={(e) => setSendSubject(e.target.value)}
                      />
                    </div>
                  )}

                  <div>
                    <label className="block text-sm font-medium text-slate-400 mb-1">Message</label>
                    <textarea
                      rows={4}
                      className="w-full bg-app-base text-white border border-white/10 rounded-xl px-4 py-2 focus:border-primary focus:outline-none resize-none text-sm"
                      value={sendMessage}
                      onChange={(e) => setSendMessage(e.target.value)}
                    />
                  </div>
                  
                  <div className="flex items-center gap-2 pt-2">
                     <button
                       onClick={() => setIncludeAttachment(!includeAttachment)}
                       className="flex items-center justify-center w-5 h-5 rounded overflow-hidden border border-white/20 bg-white/5 cursor-pointer"
                     >
                       {includeAttachment && <Check className="w-4 h-4 text-primary" />}
                     </button>
                     <span className="text-sm text-slate-300">
                       Attach Document PDF
                       {sendMethod === 'whatsapp' && includeAttachment && (
                         <span className="text-slate-500 ml-1">(PDF will be downloaded — attach it in WhatsApp)</span>
                       )}
                     </span>
                  </div>
                </div>

                <div className="flex justify-end gap-3 mt-8">
                  <button
                    onClick={() => !isSending && setIsSendModalOpen(false)}
                    className="px-5 py-2.5 rounded-xl text-slate-300 font-medium hover:bg-white/5 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSendDocument}
                    disabled={isSending}
                    className="px-5 py-2.5 bg-primary text-white rounded-xl font-bold hover:bg-primary-hover transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isSending ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                    )}
                    {isSending ? 'Preparing...' : 'Share Document'}
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </main>
  );
}
