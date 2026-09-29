const GAS_URL = "https://script.google.com/macros/s/AKfycbzbSB7EKTM5MRKtGYuisM5DZs80xmi1Rr7NH-oj9dcwKJQH6onbVcgfkAIkeBcuPT4h/exec"; 
const SUPABASE_URL = 'https://hzdmeoecwyttixxoddmy.supabase.co';
const SUPABASE_KEY = 'sb_publishable__XrYzsaWdDCEcR1DE5E-Dg_EseGu04f';

let appData = [], globalDocLinks = {}, currentUserRole = "", slipQueue = [], currentIndex = 0, currentBase64 = "", sessionRecords = [], globalSetup = {};
let isEditBatchMode = false; 
let globalRecentMonths = [];
let isOlderLoaded = false;
let modalInstance = null;

// ==========================================
// 1. ฟังก์ชันติดต่อกับ Google Apps Script (ใช้เฉพาะตอนสร้าง PDF)
// ==========================================
async function fetchGAS(payload, retries = 3) {
    for (let i = 0; i <= retries; i++) {
        try {
            let res = await fetch(GAS_URL, {
                method: 'POST',
                body: JSON.stringify(payload),
                redirect: 'follow'
            });
            let text = await res.text();
            if (!res.ok || text.includes("<html") || text.includes("Drive - Sorry") || text.includes("Not Found")) {
                throw new Error("Bad_Response");
            }
            let data = JSON.parse(text);
            if (data.message === "Backend Ready!") throw new Error("Redirect_To_GET");
            return data; 
        } catch (err) {
            if (err.message === "Redirect_To_GET" && i === retries) {
                throw new Error("ระบบ Google รวน (เปลี่ยนคำสั่งเป็น GET อัตโนมัติ)");
            }
            if (i < retries) {
                console.warn(`[ระบบ GAS] สะดุด... กำลังลองยิงซ้ำรอบที่ ${i + 1}`);
                await new Promise(resolve => setTimeout(resolve, 2000)); 
                continue;
            } else {
                throw new Error("เซิร์ฟเวอร์ Google ทำงานหนักเกินไป หรืออินเทอร์เน็ตหลุด กรุณาลองใหม่อีกครั้งครับ");
            }
        }
    }
}

// ==========================================
// 2. ฟังก์ชันติดต่อกับ Supabase โดยตรง (รวดเร็วมาก)
// ==========================================
async function fetchSupabaseClient(path, method = 'GET', payload = null) {
    const options = {
        method: method,
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
        }
    };
    if (payload) options.body = JSON.stringify(payload);
    
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, options);
    
    // ตรวจสอบถ้าไม่ใช่สถานะ 2xx
    if (!res.ok) {
        let errorText = await res.text();
        console.error("Supabase Error:", errorText);
        throw new Error(`Supabase Fetch Error: ${res.status}`);
    }
    
    // คำสั่ง DELETE/PATCH แบบไม่เอาค่าคืนกลับมา อาจจะส่ง Response ว่างเปล่ามา
    if (res.status === 204) return null; 
    
    return await res.json();
}

// ==========================================
// ส่วนจัดการ วัน/เวลา และ ฟอร์แมต
// ==========================================
function formatThaiDate(dateStr) { 
    if(!dateStr) return "";
    let parts = dateStr.split('-');
    if(parts.length === 3) { return `${parts[2]}/${parts[1]}/${parts[0].substring(2)}`; }
    return dateStr;
}

function reverseFormatDate(thaiDate) { 
    if(!thaiDate) return "";
    let parts = thaiDate.split('/');
    if(parts.length === 3) { return `20${parts[2]}-${parts[1]}-${parts[0]}`; }
    return thaiDate;
}

function displaySafeDate(d) { 
    if (!d) return "-"; 
    if (d.includes("T")) return new Date(d).toLocaleDateString('en-GB'); 
    return d; 
}

function formatDateToDDMMYY(dbDate) {
    if (!dbDate) return "";
    let parts = dbDate.split('-');
    if (parts.length >= 3) {
        return `${parts[2].substring(0,2)}/${parts[1]}/${parts[0].substring(2)}`;
    }
    return dbDate;
}

// ==========================================
// ระบบ Session และ Login
// ==========================================
function checkSession() {
    const session = JSON.parse(localStorage.getItem('mflow_session'));
    if (session && session.expire > Date.now()) {
        currentUserRole = session.role;
        document.getElementById('loginView').classList.add('hidden'); 
        document.getElementById('dashboardView').classList.remove('hidden');
        document.getElementById('userRoleBadge').innerHTML = (currentUserRole === 'admin') ? "<i class='bi bi-person-badge'></i> Admin" : "<i class='bi bi-calculator'></i> บัญชี";
        
        document.getElementById('actionBar').classList.remove('hidden');
        document.getElementById('btnExportCSV').classList.remove('hidden');
        if (currentUserRole === 'admin') { 
            document.getElementById('btnGenDoc').classList.remove('hidden');
            document.getElementById('btnImportSlip').classList.remove('hidden');
        } else {
            document.getElementById('btnGenDoc').classList.add('hidden');
            document.getElementById('btnImportSlip').classList.add('hidden');
        }
        loadDashboardData();
    } else {
        document.getElementById('loginView').classList.remove('hidden');
        document.getElementById('dashboardView').classList.add('hidden');
    }
}

async function doLogin() {
    const u = document.getElementById('username').value;
    const p = document.getElementById('password').value;
    Swal.fire({ title: 'กำลังตรวจสอบ...', allowOutsideClick: false, didOpen: () => { Swal.showLoading(); }});
    
    try {
        // ยิงตรงไปตรวจสอบในตาราง user ของ Supabase
        let result = await fetchSupabaseClient(`user?select=*&username=eq.${encodeURIComponent(u)}`);
        if (result && result.length > 0) {
            if (result[0].password === p) {
                Swal.close();
                localStorage.setItem('mflow_session', JSON.stringify({ role: result[0].role, expire: Date.now() + (7 * 24 * 60 * 60 * 1000) }));
                checkSession();
            } else {
                Swal.fire('ผิดพลาด', 'รหัสผ่านไม่ถูกต้อง', 'error');
            }
        } else {
            Swal.fire('ผิดพลาด', 'ไม่พบ Username นี้ในระบบ', 'error');
        }
    } catch (err) {
        Swal.fire('Error', err.toString(), 'error');
    }
}

function logout() { 
    localStorage.removeItem('mflow_session'); 
    location.reload(); 
}

// ==========================================
// โหลดข้อมูล Dashboard
// ==========================================
async function loadDashboardData() {
    const selectedYear = document.getElementById('filterYear').value;
    document.querySelectorAll('.currentYearLabel').forEach(el => { el.innerText = selectedYear; });

    document.getElementById('dataAccordion').innerHTML = `<div class="text-center text-secondary py-5"><div class="spinner-border spinner-border-sm text-primary mb-2"></div><br>กำลังโหลดข้อมูลล่าสุด...</div>`;

    const monthNames = ["01_Jan", "02_Feb", "03_Mar", "04_Apr", "05_May", "06_Jun", "07_Jul", "08_Aug", "09_Sep", "10_Oct", "11_Nov", "12_Dec"];
    let d = new Date();
    let cIdx = d.getMonth();
    let pIdx = cIdx === 0 ? 11 : cIdx - 1;
    
    globalRecentMonths = [monthNames[cIdx], monthNames[pIdx]];
    isOlderLoaded = false; 

    try {
        // ยิงตรงไป Supabase ดึงข้อมูลแค่ของปีและเดือนที่กำหนด 
        let path = `mflow_data?year=eq.${selectedYear}&order=month.desc,week.desc,plate.asc&limit=10000&month=in.(${encodeURIComponent(globalRecentMonths.join(','))})`;
        let allData = await fetchSupabaseClient(path);

        appData = allData.map(row => {
            let dRange = formatDateToDDMMYY(row.start_date) + " - " + formatDateToDDMMYY(row.end_date);
            return {
                id: row.id, id_doc: row.id_doc, year: row.year.toString(), month: row.month,
                week: row.week, dateRange: dRange, plate: row.plate, amount: row.amount.toString(),
                paymentDate: row.paymentdate, url: row.url
            };
        });

        // ดึงรายการป้ายทะเบียน
        let pData = await fetchSupabaseClient('plate');
        let platesList = pData.map(p => p.plate).filter(String);

        // ดึงประวัติการลิงก์
        let hData = await fetchSupabaseClient('export_history');
        globalDocLinks = {};
        hData.forEach(h => { globalDocLinks[`${h.month}|${h.week}`] = h.url; });

        document.getElementById('filterMonth').value = "";
        document.getElementById('filterWeek').value = "";
        document.getElementById('filterPlate').value = "";

        applyFilters();

        if (platesList.length > 0) {
            const dl = document.getElementById('plateList'); 
            dl.innerHTML = "";
            platesList.forEach(p => dl.innerHTML += `<option value="${p}">`);
        }

        // ให้โหลดของเก่าแอบไว้ข้างหลัง
        loadOlderDataBackground(selectedYear);
    } catch (err) {
        document.getElementById('dataAccordion').innerHTML = `<div class="text-center text-danger py-5"><i class="bi bi-exclamation-triangle fs-1"></i><br>โหลดข้อมูลไม่สำเร็จ กรุณารีเฟรช</div>`;
        console.error(err);
    }
}

async function loadOlderDataBackground(year) {
    const statsArea = document.getElementById('statTotalItems');
    if (statsArea && !document.getElementById('bgLoadBadge')) {
        statsArea.innerHTML += ` <span id="bgLoadBadge" class="badge bg-warning text-dark ms-3 fs-6 align-middle fw-normal shadow-sm"><span class="spinner-border spinner-border-sm" style="width: 1rem; height: 1rem; border-width: 0.15em;"></span> กำลังซิงค์ประวัติ...</span>`;
    }

    try {
        let path = `mflow_data?year=eq.${year}&order=month.desc,week.desc,plate.asc&limit=10000&month=not.in.(${encodeURIComponent(globalRecentMonths.join(','))})`;
        let allData = await fetchSupabaseClient(path);

        if (allData && allData.length > 0) {
            let mappedData = allData.map(row => {
                let dRange = formatDateToDDMMYY(row.start_date) + " - " + formatDateToDDMMYY(row.end_date);
                return {
                    id: row.id, id_doc: row.id_doc, year: row.year.toString(), month: row.month,
                    week: row.week, dateRange: dRange, plate: row.plate, amount: row.amount.toString(),
                    paymentDate: row.paymentdate, url: row.url
                };
            });
            appData = appData.concat(mappedData);
            isOlderLoaded = true;
            
            let b = document.getElementById('bgLoadBadge');
            if (b) {
                b.className = "badge bg-success text-white ms-3 fs-6 align-middle fw-normal shadow-sm";
                b.innerHTML = `<i class="bi bi-check-circle"></i> อัปเดตครบแล้ว`;
                setTimeout(() => b.remove(), 3000);
            }

            const fMonth = document.getElementById('filterMonth').value;
            const fWeek = document.getElementById('filterWeek').value;
            const fPlate = document.getElementById('filterPlate').value.trim();
            if(!fMonth && !fWeek && !fPlate) {
                applyFilters();
            }
        } else {
            let b = document.getElementById('bgLoadBadge');
            if (b) b.remove();
        }
    } catch(e) {
        let b = document.getElementById('bgLoadBadge');
        if (b) b.remove();
    }
}

// ==========================================
// ส่วนฟิลเตอร์และแสดงผลในตาราง
// ==========================================
function applyFilters() {
    const fMonth = document.getElementById('filterMonth').value;
    const fWeek = document.getElementById('filterWeek').value;
    const fPlate = document.getElementById('filterPlate').value.toLowerCase().trim();
    
    let filteredData = appData.filter(row => 
        (fMonth === "" || row.month == fMonth) && 
        (fWeek === "" || row.week == fWeek) && 
        (fPlate === "" || row.plate.toLowerCase().includes(fPlate))
    );
    
    let totalAmt = 0; 
    filteredData.forEach(r => totalAmt += parseFloat(r.amount));
    
    const badgeHtml = document.getElementById('bgLoadBadge') ? document.getElementById('bgLoadBadge').outerHTML : '';
    document.getElementById('statTotalItems').innerHTML = `${filteredData.length} <span class="fs-6 fw-normal text-muted">รายการ</span>` + badgeHtml; 
    document.getElementById('statTotalAmount').innerHTML = `${totalAmt.toLocaleString()} <span class="fs-6 fw-normal text-muted">บาท</span>`;
    
    renderGroupedAccordion(filteredData);
}

function resetFilters() { 
    document.getElementById('filterMonth').value = ""; 
    document.getElementById('filterWeek').value = ""; 
    document.getElementById('filterPlate').value = ""; 
    applyFilters(); 
}

function renderGroupedAccordion(dataArray) {
    const container = document.getElementById('dataAccordion'); 
    
    if (dataArray.length === 0) {
        container.innerHTML = `<div class="text-center text-secondary py-5"><i class="bi bi-inbox fs-1"></i><br>ไม่พบข้อมูลในช่วงที่เลือก</div>`;
        return;
    }
    
    let groupedData = {};
    dataArray.forEach(row => {
        let safeDate = displaySafeDate(row.paymentDate);
        let key = `${row.month}|${row.week}|${safeDate}`;
        if (!groupedData[key]) { 
            groupedData[key] = { month: row.month, week: row.week, paymentDate: safeDate, dateRange: row.dateRange, items: [], totalAmount: 0 }; 
        }
        groupedData[key].items.push(row); 
        groupedData[key].totalAmount += parseFloat(row.amount);
    });

    let sortedKeys = Object.keys(groupedData).sort((a, b) => {
        return b.localeCompare(a); 
    });

    let idx = 0;
    let fullHtml = "";
    
    for (const key of sortedKeys) {
        const group = groupedData[key]; 

        let rows = "";
        group.items.forEach(item => { 
            let safeDate = displaySafeDate(item.paymentDate);
            rows += `
                <tr class="border-bottom border-secondary">
                    <td class="text-center"><input class="form-check-input item-checkbox" type="checkbox" value="${item.id}" onchange="checkMasterToggle('collapse_${idx}')"></td>
                    <td class="text-light fw-bold">${item.plate}</td>
                    <td class="text-success fw-bold text-end pe-4">${item.amount} ฿</td>
                    <td class="text-light text-center">${safeDate}</td>
                    <td class="text-center"><a href="${item.url}" target="_blank" class="btn btn-sm btn-outline-info rounded-pill px-3 py-0">ดูสลิป</a></td>
                </tr>`; 
        });
        
        let pdfLink = globalDocLinks[`${group.month}|${group.week}`];
        let statusHtml = "";
        if (pdfLink) {
            statusHtml = `
                <span class="badge bg-success ms-2 px-2 py-1"><i class="bi bi-check-circle"></i> ออกเอกสารแล้ว</span>
                <a href="${pdfLink}" target="_blank" class="btn btn-sm btn-outline-success fw-bold px-3 ms-2"><i class="bi bi-file-earmark-pdf"></i> เปิดดูเอกสาร</a>
            `;
        }

        let headerEditBtn = "";
        if (currentUserRole === 'admin') {
            headerEditBtn = `<div class="ps-3 border-start border-secondary py-2 ms-2 d-flex align-items-center"><button class="btn btn-warning btn-sm fw-bold px-3 py-1 text-dark" style="white-space: nowrap;" onclick="openEditBatch('${group.month}', '${group.week}')"><i class="bi bi-pencil-square me-1"></i> แก้ไข</button></div>`;
        }

        fullHtml += `
            <div class="accordion-item border-0 mb-3 shadow-sm" style="background-color: #1e293b; border-radius: 10px; overflow: hidden;">
                <div class="d-flex align-items-center flex-nowrap w-100 bg-dark bg-opacity-50 pe-2">
                    <div class="p-3 border-end border-secondary d-flex align-items-center justify-content-center flex-shrink-0" style="width: 60px;">
                        <input class="form-check-input group-checkbox m-0" type="checkbox" style="transform: scale(1.3); cursor: pointer;" onchange="toggleAllInGroupFromHeader(this, 'collapse_${idx}')">
                    </div>
                    <div class="flex-grow-1 d-flex align-items-center px-3 py-3 collapsed" data-bs-toggle="collapse" data-bs-target="#collapse_${idx}" style="cursor: pointer; user-select: none;">
                        <span class="fs-6 text-info fw-bold" style="white-space: nowrap;">${group.month} - ${group.week} <span class="text-warning ms-1" style="font-size:0.85em;">(จ่าย: ${group.paymentDate})</span></span> 
                        <span class="text-muted ms-2 small d-none d-md-inline" style="white-space: nowrap;">(${group.dateRange})</span>
                        <i class="bi bi-chevron-down text-secondary ms-2 custom-caret"></i>
                    </div>
                    <div class="d-flex align-items-center flex-shrink-0 flex-nowrap gap-2">
                        ${statusHtml}
                        <div class="text-light text-end d-none d-sm-block ms-2 border-start border-secondary ps-3">
                            <span class="text-secondary small me-1">จำนวน:</span>
                            <span class="fw-bold fs-6">${group.items.length} <small class="fw-normal">คัน</small></span>
                        </div>
                        <div class="text-success border-start border-secondary ps-3 text-end">
                            <span class="text-secondary small me-1">ยอดรวม:</span>
                            <span class="fw-bold fs-5">${group.totalAmount.toLocaleString()} <small class="fw-normal">฿</small></span>
                        </div>
                        ${headerEditBtn}
                    </div>
                </div>
                <div id="collapse_${idx}" class="accordion-collapse collapse" data-bs-parent="#dataAccordion">
                    <div class="accordion-body">
                        <div class="table-responsive">
                            <table class="table table-sm table-borderless table-hover align-middle mb-0">
                                <thead class="bg-dark text-secondary">
                                    <tr>
                                        <th class="text-center" width="5%"><input class="form-check-input master-checkbox" type="checkbox" onchange="toggleAllInGroup(this, 'collapse_${idx}')"></th>
                                        <th width="30%">ทะเบียนรถ</th>
                                        <th class="text-end pe-4" width="20%">ยอดเงิน</th>
                                        <th class="text-center" width="25%">วันที่จ่าย</th>
                                        <th class="text-center" width="20%">หลักฐาน</th>
                                    </tr>
                                </thead>
                                <tbody>${rows}</tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>`;
        idx++;
    }
    
    container.innerHTML = fullHtml;
}

function toggleAllInGroupFromHeader(headerCb, cId) {
    let masterCb = document.querySelector(`#${cId} .master-checkbox`);
    if(masterCb) masterCb.checked = headerCb.checked;
    document.querySelectorAll(`#${cId} .item-checkbox`).forEach(cb => cb.checked = headerCb.checked);
}

function toggleAllInGroup(masterCb, cId) {
    document.querySelectorAll(`#${cId} .item-checkbox`).forEach(cb => cb.checked = masterCb.checked);
    let headerCb = masterCb.closest('.accordion-item').querySelector('.group-checkbox');
    if(headerCb) { headerCb.checked = masterCb.checked; headerCb.indeterminate = false; }
}

function checkMasterToggle(cId) {
    let items = document.querySelectorAll(`#${cId} .item-checkbox`);
    let checked = document.querySelectorAll(`#${cId} .item-checkbox:checked`);
    let isAll = (items.length > 0 && items.length === checked.length);
    let isSome = (checked.length > 0 && checked.length < items.length);
    
    let masterCb = document.querySelector(`#${cId} .master-checkbox`);
    if(masterCb) { masterCb.checked = isAll; masterCb.indeterminate = isSome; }
    
    let headerCb = document.querySelector(`#${cId}`).closest('.accordion-item').querySelector('.group-checkbox');
    if(headerCb) { headerCb.checked = isAll; headerCb.indeterminate = isSome; }
}

function getSelectedIds() {
    let ids = Array.from(document.querySelectorAll('.item-checkbox:checked')).map(cb => cb.value);
    if(ids.length === 0) { Swal.fire('โปรดเลือกรายการ', 'กรุณาติ๊กเลือกหน้ารายการที่ต้องการก่อนครับ', 'warning'); return null; }
    return ids;
}

// ==========================================
// เรียกใช้งานสร้างเอกสาร PDF (ต้องผ่าน GAS)
// ==========================================
function requestGenerateAllPDFs() {
    const ids = getSelectedIds(); 
    if(!ids) return;

    const selectedYear = document.getElementById('filterYear').value;
    let selectedItems = appData.filter(r => ids.includes(r.id));
    
    let uniqueWeeks = [...new Set(selectedItems.map(r => `${r.month}|${r.week}`))];
    if (uniqueWeeks.length > 1) {
        Swal.fire({ title: 'ข้อควรระวัง!', html: 'กรุณาเลือกทำเอกสาร <b>ทีละ 1 สัปดาห์</b> ครับ', icon: 'warning', confirmButtonColor: '#3b82f6', confirmButtonText: 'เข้าใจแล้ว' });
        return;
    }

    let firstItem = selectedItems[0];
    let currentKey = `${firstItem.month}|${firstItem.week}`;
    let allUniqueKeys = [...new Set(appData.map(r => `${r.month}|${r.week}`))].sort();
    let currentIndex = allUniqueKeys.indexOf(currentKey);
    
    let suggestedBalance = 80000;
    let suggestedTransfer = 0;
    if (currentIndex > 0) {
        let prevKey = allUniqueKeys[currentIndex - 1];
        let [prevMonth, prevWeek] = prevKey.split('|');
        let prevExpenses = appData.filter(r => r.month === prevMonth && r.week === prevWeek).reduce((sum, r) => sum + parseFloat(r.amount), 0);
        suggestedBalance = 80000 - prevExpenses;
        suggestedTransfer = prevExpenses; 
    }

    Swal.fire({
        title: 'สร้างเอกสารใหม่ (' + selectedYear + ')',
        html: `
            <div class="mb-3 text-start">
                <label class="form-label text-secondary small">ยอดคงเหลือยกมา (ฐาน 80,000 บาท)</label>
                <input id="swal-balance" class="form-control bg-dark text-light border-secondary" type="number" value="${suggestedBalance}">
            </div>
            <div class="mb-3 text-start">
                <label class="form-label text-secondary small">วันที่และเวลารับโอนเงิน (แสดงที่ช่อง E9)</label>
                <div class="input-group">
                    <input id="swal-tdate" class="form-control bg-dark text-light border-secondary" type="date">
                    <input id="swal-ttime" class="form-control bg-dark text-light border-secondary" type="text" placeholder="เช่น 12:54">
                </div>
            </div>
            <div class="mb-2 text-start">
                <label class="form-label text-secondary small">ยอดเงินที่รับโอน (แสดงที่ช่อง F9)</label>
                <input id="swal-tamount" class="form-control bg-dark text-light border-secondary" type="number" value="${suggestedTransfer}">
            </div>
        `,
        icon: 'info', showCancelButton: true, confirmButtonColor: '#3b82f6', cancelButtonColor: '#64748b', confirmButtonText: 'ยืนยันสร้างเอกสาร', cancelButtonText: 'ยกเลิก',
        preConfirm: () => {
            const b = document.getElementById('swal-balance').value;
            const d = document.getElementById('swal-tdate').value;
            const t = document.getElementById('swal-ttime').value;
            const a = document.getElementById('swal-tamount').value;
            if (!b) { Swal.showValidationMessage('กรุณาระบุยอดคงเหลือยกมา'); return false; }
            return { balance: b, date: d, time: t, tamount: a };
        }
    }).then(async (result) => {
        if (result.isConfirmed) {
            let fwBalance = parseFloat(result.value.balance) || 0;
            let tAmount = parseFloat(result.value.tamount) || 0;
            let formattedDate = result.value.date ? formatThaiDate(result.value.date) : "";
            generatePDFOldWay(ids, selectedYear, fwBalance, formattedDate, result.value.time, tAmount);
        }
    });
}

async function generatePDFOldWay(ids, year, fwBalance, tDate, tTime, tAmount) {
    document.getElementById('loadingOverlay').classList.remove('hidden'); 
    document.getElementById('pdfProgressBar').style.width = '50%';
    document.getElementById('pdfProgressBar').innerText = 'กำลังสร้าง PDF...';
    document.getElementById('pdfProgressText').innerText = 'กำลังดึงข้อมูลและจัดทำเอกสาร (ใช้เวลาประมาณ 1-2 นาที)...';

    try {
        let res = await fetchGAS({ 
            action: 'generatePDFOnly', 
            ids: ids, 
            year: year,
            forwardBalance: fwBalance, 
            transferDate: tDate, 
            transferTime: tTime, 
            transferAmount: tAmount 
        });
        
        if (res.status !== 'success') throw new Error(res.message);

        document.getElementById('pdfProgressBar').style.width = '100%';
        document.getElementById('pdfProgressBar').innerText = 'เสร็จสมบูรณ์!';
        document.getElementById('loadingOverlay').classList.add('hidden'); 
        
        Swal.fire({ title: 'สำเร็จ!', text: 'เอกสารและชีตสำเร็จ!', icon: "success", confirmButtonText: 'เปิดไฟล์ PDF' }).then(() => { 
            window.open(res.url, '_blank'); 
            loadDashboardData(); 
        });

    } catch (error) {
        document.getElementById('loadingOverlay').classList.add('hidden'); 
        Swal.fire('ขัดข้องตอนสร้าง PDF', error.message, 'error').then(loadDashboardData);
    }
}

// ==========================================
// อื่นๆ
// ==========================================
function processExportChecked() {
    const ids = getSelectedIds(); 
    if(!ids) return;
    
    let exportData = appData.filter(row => ids.includes(row.id));
    let csv = "\uFEFFรอบเบิก,ช่วงวันที่,ทะเบียนรถ,ยอดเงิน,วันที่จ่าย,ลิงก์สลิป\n";
    exportData.forEach(r => {
        csv += `"${r.month} ${r.week}","${r.dateRange}","${r.plate}","${r.amount}","${displaySafeDate(r.paymentDate)}","${r.url}"\n`;
    });
    
    const link = document.createElement("a"); 
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    link.download = `MFlow_Export_${new Date().getTime()}.csv`; 
    document.body.appendChild(link); 
    link.click(); 
    document.body.removeChild(link);
}

function openEditBatch(month, week) {
    isEditBatchMode = true; 
    const selectedYear = document.getElementById('filterYear').value;
    document.getElementById('dashboardView').classList.add('hidden'); 
    document.getElementById('importView').classList.remove('hidden');
    document.getElementById('importTitle').innerHTML = `<i class="bi bi-pencil-square"></i> จัดการข้อมูลย้อนหลัง (${month} - ${week})`;
    document.getElementById('setupSection').classList.add('hidden'); 
    document.getElementById('processingSection').classList.add('hidden');
    document.getElementById('importSummaryView').classList.remove('hidden');
    
    const btnDelWeek = document.getElementById('btnDeleteWholeWeek');
    if(btnDelWeek) btnDelWeek.classList.remove('hidden');
    
    sessionRecords = appData.filter(r => r.month === month && r.week === week).map(r => ({ 
        id: r.id, plate: r.plate, amount: r.amount, date: displaySafeDate(r.paymentDate), year: r.year, 
        month: r.month, week: r.week, uploaded: true
    })); 
    renderSummaryTable();
}

async function lookupDateRange() {
    const m = document.getElementById('setMonth').value;
    const w = document.getElementById('setWeek').value;
    const y = document.getElementById('setYear').value;
    const status = document.getElementById('lookupStatus');
    const sInp = document.getElementById('setStartDate');
    const eInp = document.getElementById('setEndDate');
    
    status.innerText = "กำลังค้นหาประวัติ..."; 
    status.className = "status-badge bg-info text-dark";
    
    let allUniqueKeys = [...new Set(appData.map(r => `${r.month}|${r.week}`))].sort();
    let currentKey = `${m}|${w}`;
    let currentIndex = allUniqueKeys.indexOf(currentKey);
    let suggestedBalance = 80000;
    let suggestedTransfer = 0;
    
    if (allUniqueKeys.length > 0) {
        let prevKey = (currentIndex > 0) ? allUniqueKeys[currentIndex - 1] : (currentIndex === -1 ? allUniqueKeys[allUniqueKeys.length - 1] : "");
        if (prevKey) {
            let [prevMonth, prevWeek] = prevKey.split('|');
            let prevExpenses = appData.filter(r => r.month === prevMonth && r.week === prevWeek).reduce((sum, r) => sum + parseFloat(r.amount), 0);
            suggestedBalance = 80000 - prevExpenses;
            suggestedTransfer = prevExpenses; 
        }
    }
    document.getElementById('setForwardBalance').value = suggestedBalance;
    document.getElementById('setTransferAmount').value = suggestedTransfer;

    try {
        let data = await fetchSupabaseClient(`mflow_data?year=eq.${parseInt(y)}&month=eq.${encodeURIComponent(m)}&week=eq.${encodeURIComponent(w)}&limit=1`);
        if (data && data.length > 0) { 
            status.innerText = "พบข้อมูลเดิม"; 
            status.className = "status-badge bg-success text-dark"; 
            sInp.value = data[0].start_date; 
            eInp.value = data[0].end_date; 
            sInp.readOnly = eInp.readOnly = true; 
        } else { 
            status.innerText = "รอบใหม่ (ระบุวันที่)"; 
            status.className = "status-badge bg-warning text-dark"; 
            sInp.value = eInp.value = ""; 
            sInp.readOnly = eInp.readOnly = false; 
        }
    } catch(err) { 
        console.error(err); 
    }
}

function openImportView() {
    isEditBatchMode = false; 
    document.getElementById('dashboardView').classList.add('hidden'); 
    document.getElementById('importView').classList.remove('hidden');
    document.getElementById('importTitle').innerHTML = `<i class="bi bi-cloud-arrow-up"></i> IMPORT SLIPS`;
    document.getElementById('setupSection').classList.remove('hidden'); 
    document.getElementById('processingSection').classList.add('hidden');
    document.getElementById('importSummaryView').classList.add('hidden'); 
    
    const btnDelWeek = document.getElementById('btnDeleteWholeWeek');
    if(btnDelWeek) btnDelWeek.classList.add('hidden');
    
    sessionRecords = []; 
    
    const d = new Date();
    const monthNames = ["01_Jan", "02_Feb", "03_Mar", "04_Apr", "05_May", "06_Jun", "07_Jul", "08_Aug", "09_Sep", "10_Oct", "11_Nov", "12_Dec"];
    
    const yearOpt = document.getElementById('setYear').querySelector(`option[value="${d.getFullYear()}"]`);
    if(yearOpt) yearOpt.selected = true;
    document.getElementById('setMonth').value = monthNames[d.getMonth()];
    
    document.getElementById('setPaymentDate').value = "";
    document.getElementById('setTransferDate').value = "";
    document.getElementById('setTransferTime').value = "";
    document.getElementById('slipFiles').value = "";

    lookupDateRange();
}

function backToDashboard() { 
    document.getElementById('importView').classList.add('hidden'); 
    document.getElementById('dashboardView').classList.remove('hidden'); 
    loadDashboardData(); 
}

function startImport() {
    const sD = document.getElementById('setStartDate').value;
    const eD = document.getElementById('setEndDate').value;
    const pD = document.getElementById('setPaymentDate').value;
    const files = document.getElementById('slipFiles').files;
    
    const fwBal = document.getElementById('setForwardBalance').value;
    const tAmt = document.getElementById('setTransferAmount').value;
    
    if(!sD || !eD || !pD) return Swal.fire('คำเตือน', 'โปรดระบุวันที่ให้ครบถ้วน', 'warning'); 
    if(!fwBal) return Swal.fire('คำเตือน', 'โปรดระบุยอดคงเหลือยกมาก่อนครับ', 'warning');
    if(files.length === 0) return Swal.fire('คำเตือน', 'โปรดเลือกไฟล์สลิปก่อนครับ', 'warning');
    
    globalSetup = { 
        year: document.getElementById('setYear').value,
        month: document.getElementById('setMonth').value, 
        week: document.getElementById('setWeek').value, 
        dateRange: `${formatThaiDate(sD)} - ${formatThaiDate(eD)}`, 
        paymentDate: formatThaiDate(pD),
        sessionId: new Date().getTime(),
        forwardBalance: fwBal,
        transferAmount: tAmt,
        transferDateRaw: document.getElementById('setTransferDate').value,
        transferTimeRaw: document.getElementById('setTransferTime').value
    };
    
    slipQueue = Array.from(files); 
    currentIndex = 0; 
    document.getElementById('setupSection').classList.add('hidden'); 
    document.getElementById('processingSection').classList.remove('hidden'); 
    showCurrentSlip();
}

function showCurrentSlip() {
    if(currentIndex >= slipQueue.length) {
        return showSessionSummary();
    }
    
    document.getElementById('counterBadge').innerText = `ใบที่ ${currentIndex + 1} / ${slipQueue.length}`; 
    document.getElementById('inputAmount').value = ""; 
    document.getElementById('inputPlate').value = ""; 
    document.getElementById('inputAmount').focus(); 
    
    const reader = new FileReader(); 
    reader.onload = e => { 
        const img = new Image(); 
        img.onload = () => { 
            const canvas = document.createElement('canvas'); 
            const MAX_WIDTH = 400;
            canvas.width = MAX_WIDTH; 
            canvas.height = img.height * (MAX_WIDTH / img.width); 
            const ctx = canvas.getContext('2d'); 
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height); 
            currentBase64 = canvas.toDataURL('image/jpeg', 0.6); 
            document.getElementById('slipImagePreview').src = currentBase64; 
        }; 
        img.src = e.target.result; 
    }; 
    reader.readAsDataURL(slipQueue[currentIndex]);
}

function saveData() {
    const plate = document.getElementById('inputPlate').value;
    const amt = document.getElementById('inputAmount').value;
    
    if(!plate || !amt) return Swal.fire('คำเตือน', 'กรุณากรอกข้อมูลให้ครบ', 'warning');
    
    const currentRowId = "MF-" + globalSetup.sessionId + "-" + currentIndex;
    
    sessionRecords.push({ 
        id: currentRowId, plate: plate, amount: amt, date: globalSetup.paymentDate, year: globalSetup.year, base64: currentBase64, uploaded: false
    }); 
    
    currentIndex++; 
    showCurrentSlip(); 
}

function showSessionSummary() { 
    document.getElementById('processingSection').classList.add('hidden'); 
    document.getElementById('importSummaryView').classList.remove('hidden'); 
    renderSummaryTable(); 
}

function renderSummaryTable() {
    let totalAmt = 0; 
    let rowsHtml = "";
    const tbody = document.getElementById('importSummaryTableBody'); 
    
    sessionRecords.forEach(r => { 
        totalAmt += parseFloat(r.amount); 
        let btnDisabled = (r.uploaded && !isEditBatchMode) ? 'disabled' : '';
        
        rowsHtml += `
            <tr class="border-bottom border-secondary">
                <td class="text-light">${r.plate}</td>
                <td class='text-success fw-bold'>${r.amount}</td>
                <td class="text-light">${r.date}</td>
                <td class="text-end pe-3">
                    <button class="btn btn-sm btn-outline-warning rounded-circle me-1" onclick="openEditModal('${r.id}')" ${btnDisabled}><i class="bi bi-pencil"></i></button>
                    <button class="btn btn-sm btn-outline-danger rounded-circle" onclick="deleteRecord('${r.id}')" ${btnDisabled}><i class="bi bi-trash"></i></button>
                </td>
            </tr>`; 
    });
    
    tbody.innerHTML = rowsHtml;
    
    document.getElementById('sumCount').innerText = sessionRecords.length; 
    document.getElementById('sumAmount').innerText = totalAmt.toLocaleString() + " ฿";

    document.getElementById('btnFinalizeImport').innerHTML = isEditBatchMode 
        ? '<i class="bi bi-arrow-left"></i> กลับไปหน้าหลัก' 
        : '<i class="bi bi-cloud-upload"></i> ยืนยันข้อมูล อัปโหลด และสร้าง PDF ทันที (ม้วนเดียวจบ)';
}

function openEditModal(id) { 
    const r = sessionRecords.find(x => x.id === id); 
    if(!r) return; 
    document.getElementById('editId').value = id; 
    document.getElementById('editPlate').value = r.plate; 
    document.getElementById('editAmount').value = r.amount; 
    document.getElementById('editDate').value = r.date; 
    modalInstance = new bootstrap.Modal(document.getElementById('editModal')); 
    modalInstance.show(); 
}

// 🚀 แก้ไขข้อมูลแบบยิงตรง Supabase
async function saveEdit() {
    const id = document.getElementById('editId').value;
    const nPlate = document.getElementById('editPlate').value;
    const nAmt = document.getElementById('editAmount').value;
    const nDate = document.getElementById('editDate').value;
    const record = sessionRecords.find(x => x.id === id);
    if (!record) return;
    
    if (isEditBatchMode) {
        Swal.fire({ title: 'กำลังบันทึก...', allowOutsideClick: false, didOpen: () => { Swal.showLoading(); }});
        try {
            await fetchSupabaseClient(`mflow_data?id=eq.${id}`, 'PATCH', { 
                plate: nPlate, 
                amount: parseInt(nAmt) || 0, 
                paymentdate: nDate 
            });
            const idx = sessionRecords.findIndex(x => x.id === id); 
            sessionRecords[idx].plate = nPlate; 
            sessionRecords[idx].amount = nAmt; 
            sessionRecords[idx].date = nDate; 
            modalInstance.hide(); 
            renderSummaryTable(); 
            Swal.fire('สำเร็จ', 'อัปเดตข้อมูลเรียบร้อยแล้ว', 'success');
        } catch (error) {
            Swal.fire('ขัดข้อง', error.message || 'ไม่สามารถแก้ไขได้', 'error');
        }
    } else {
        const idx = sessionRecords.findIndex(x => x.id === id); 
        sessionRecords[idx].plate = nPlate; 
        sessionRecords[idx].amount = nAmt; 
        sessionRecords[idx].date = nDate; 
        modalInstance.hide(); 
        renderSummaryTable(); 
    }
}

// 🚀 ลบข้อมูล (ต้องส่ง GAS ไปลบไฟล์ แล้วให้ Supabase ลบข้อมูล)
function deleteRecord(id) { 
    Swal.fire({ 
        title: 'ลบรายการ?', text: "ยืนยันการลบข้อมูลนี้หรือไม่?", icon: 'warning', 
        showCancelButton: true, confirmButtonColor: '#d33', cancelButtonColor: '#3085d6', confirmButtonText: 'ลบเลย!' 
    }).then(async (result) => {
        if (result.isConfirmed) {
            const record = sessionRecords.find(x => x.id === id);
            if (!record) return;

            if (isEditBatchMode) {
                Swal.fire({ title: 'กำลังลบ...', allowOutsideClick: false, didOpen: () => { Swal.showLoading(); }});
                try {
                    // ส่งไป GAS ให้ลบเฉพาะไฟล์รูป
                    await fetchGAS({ action: 'deleteSlip', id: id, year: record.year });
                    
                    // ยิงตรงไปลบข้อมูลใน Supabase
                    await fetchSupabaseClient(`mflow_data?id=eq.${id}`, 'DELETE');
                    
                    sessionRecords = sessionRecords.filter(x => x.id !== id); 
                    renderSummaryTable(); 
                    Swal.fire('สำเร็จ', 'ลบรายการและไฟล์รูปภาพเรียบร้อยแล้ว', 'success');
                } catch (error) {
                    Swal.fire('ขัดข้อง', error.message, 'error');
                }
            } else {
                sessionRecords = sessionRecords.filter(x => x.id !== id); 
                renderSummaryTable(); 
            }
        }
    });
}

// 🚀 ลบทั้งสัปดาห์
function deleteWholeWeek() {
    if(sessionRecords.length === 0) return;
    const record = sessionRecords[0];
    const year = record.year;
    const month = record.month;
    const week = record.week;

    Swal.fire({
        title: 'ยืนยันลบทั้งสัปดาห์?',
        text: `คุณต้องการลบข้อมูลสลิปและ PDF ของรอบ ${month} - ${week} ทั้งหมดใช่หรือไม่? (ไม่สามารถกู้คืนไฟล์ได้)`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        cancelButtonColor: '#3085d6',
        confirmButtonText: 'ลบข้อมูลทั้งหมด',
        cancelButtonText: 'ยกเลิก'
    }).then(async (result) => {
        if (result.isConfirmed) {
            Swal.fire({ title: 'กำลังลบข้อมูลและไฟล์ภาพ...', allowOutsideClick: false, didOpen: () => { Swal.showLoading(); }});
            try {
                // ส่งไป GAS ให้ลบ Folder ไฟล์รูป
                await fetchGAS({ action: 'deleteWholeWeek', year: year, month: month, week: week });
                
                // ลบจาก Supabase ตรงๆ
                await fetchSupabaseClient(`mflow_data?year=eq.${parseInt(year)}&month=eq.${encodeURIComponent(month)}&week=eq.${encodeURIComponent(week)}`, 'DELETE');
                await fetchSupabaseClient(`export_history?month=eq.${encodeURIComponent(month)}&week=eq.${encodeURIComponent(week)}`, 'DELETE');
                
                Swal.fire('สำเร็จ', 'ลบข้อมูลทั้งสัปดาห์เคลียร์ออกจากระบบเรียบร้อยแล้ว', 'success').then(() => {
                    backToDashboard();
                });
            } catch (error) {
                Swal.fire('ขัดข้อง', error.message, 'error');
            }
        }
    });
}

function finalizeAction() {
    if (isEditBatchMode) {
        backToDashboard();
    } else {
        confirmAndUploadAll();
    }
}

async function confirmAndUploadAll() {
    document.getElementById('importSummaryView').classList.add('hidden');
    document.getElementById('loadingOverlay').classList.remove('hidden');

    document.getElementById('pdfProgressText').innerText = 'กำลังอัปโหลดและสร้าง PDF แบบรวดเดียวจบ (ใช้เวลา 1-2 นาที โปรดรอสักครู่)...';
    document.getElementById('pdfProgressBar').style.width = '50%';
    document.getElementById('pdfProgressBar').innerText = 'กำลังส่งข้อมูลและบันทึกลงระบบ...';

    let recordsToUpload = sessionRecords.filter(r => !r.uploaded);
    
    let tDateStr = "";
    let tAmtRaw = parseFloat(globalSetup.transferAmount) || 0;
    let tAmtStr = tAmtRaw ? tAmtRaw.toLocaleString('en-US',{minimumFractionDigits:2}) : "0.00";
    if (globalSetup.transferDateRaw) {
        tDateStr = formatThaiDate(globalSetup.transferDateRaw);
        if (globalSetup.transferTimeRaw) tDateStr += " เวลา " + globalSetup.transferTimeRaw + " น.";
    }

    try {
        let res = await fetchGAS({
            action: 'saveAllAndGeneratePDF',
            year: globalSetup.year,
            month: globalSetup.month,
            week: globalSetup.week,
            dateRange: globalSetup.dateRange,
            forwardBalance: parseFloat(globalSetup.forwardBalance) || 0, 
            transferDateStr: tDateStr,
            transferAmountStr: tAmtStr,
            records: recordsToUpload.map(r => ({
                id: r.id,
                plate: r.plate,
                amount: r.amount,
                date: r.date,
                base64: r.base64
            }))
        });

        if (res.status === 'success') {
            document.getElementById('pdfProgressBar').style.width = '100%';
            document.getElementById('pdfProgressBar').innerText = 'เสร็จสมบูรณ์!';
            sessionRecords.forEach(r => r.uploaded = true);

            document.getElementById('loadingOverlay').classList.add('hidden');
            Swal.fire('เสร็จสิ้น!', 'บันทึกข้อมูลและสร้าง PDF เรียบร้อยแล้ว!', 'success').then(() => {
                window.open(res.url, '_blank');
                backToDashboard();
            });
        } else {
            throw new Error(res.message);
        }
    } catch (err) {
        document.getElementById('loadingOverlay').classList.add('hidden');
        Swal.fire('ขัดข้อง', err.message, 'error').then(() => {
            document.getElementById('importSummaryView').classList.remove('hidden');
        });
    }
}

checkSession();