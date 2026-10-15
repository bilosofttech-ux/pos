const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

// Helper: Dynamically synchronize User Accounts & Role Permissions into Employee Directory
async function syncUserAccountsWithEmployees() {
  try {
    // 1. Fetch all system User accounts from PostgreSQL
    const users = await prisma.user.findMany({
      include: { permissions: true },
    });

    // 2. Clean up any orphaned employees whose user accounts were deleted
    const allEmps = await prisma.employee.findMany();
    for (const emp of allEmps) {
      const isMatch = users.some(
        (u) =>
          (emp.empNo && emp.empNo.toUpperCase() === `EMP-${u.username.toUpperCase()}`) ||
          (emp.email && u.email && emp.email.toLowerCase() === u.email.toLowerCase()) ||
          (emp.fullName && u.fullName && emp.fullName.toLowerCase() === u.fullName.toLowerCase())
      );
      if (!isMatch) {
        await prisma.employee.delete({ where: { id: emp.id } }).catch(() => null);
      }
    }

    // 3. Synchronize users to employees with exact role, basicSalary, commissionRate
    for (const user of users) {
      const userRole = user.role || 'Salesman';
      const userSalary = userRole === 'Admin' ? 0 : parseFloat(user.salary || 0);
      const empNo = `EMP-${user.username.toUpperCase()}`;

      let existingEmp = await prisma.employee.findFirst({
        where: {
          OR: [
            { empNo },
            ...(user.email ? [{ email: user.email }] : []),
            ...(user.fullName ? [{ fullName: user.fullName }] : []),
          ],
        },
      });

      const department = userRole === 'Cashier' || userRole === 'Salesman'
        ? 'Counter Sales'
        : userRole === 'Accountant'
          ? 'Accounts & Finance'
          : userRole === 'Purchase Officer'
            ? 'Procurement & Purchases'
            : userRole === 'Warehouse Manager'
              ? 'Warehouse & Logistics'
              : 'Administration';

      if (!existingEmp) {
        await prisma.employee.create({
          data: {
            empNo,
            fullName: user.fullName,
            email: user.email || `${user.username}@pharmacareerp.com`,
            phone: '0300-1112233',
            cnic: '35202-1234567-1',
            designation: userRole,
            department: department,
            basicSalary: userSalary,
            commissionRate: parseFloat(user.commissionRate || 1.0),
            bankAccount: `PK-ACC-${user.username.toUpperCase()}-001`,
            isActive: user.isActive !== undefined ? user.isActive : true,
          },
        });
      } else {
        await prisma.employee.update({
          where: { id: existingEmp.id },
          data: {
            empNo,
            fullName: user.fullName,
            email: user.email || existingEmp.email,
            designation: userRole,
            department: department,
            basicSalary: userSalary,
            commissionRate: parseFloat(user.commissionRate || 1.0),
            isActive: user.isActive !== undefined ? user.isActive : true,
          },
        });
      }
    }
  } catch (err) {
    console.error('Error syncing user accounts with employee directory:', err);
  }
}

// ─────────────────────────────────────────────
// 1. EMPLOYEES DIRECTORY API (DYNAMIC SYSTEM USERS)
// ─────────────────────────────────────────────
router.get('/employees', async (req, res) => {
  try {
    await syncUserAccountsWithEmployees();

    const employees = await prisma.employee.findMany({
      include: {
        attendances: { orderBy: { date: 'desc' }, take: 10 },
        leaves: { orderBy: { createdAt: 'desc' } },
        payrolls: { orderBy: { createdAt: 'desc' } },
        advances: { orderBy: { createdAt: 'desc' } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Also attach system User accounts & Role Permissions and live Commission & Advances to each employee record
    const users = await prisma.user.findMany({
      include: { permissions: true },
    });

    const allInvoices = await prisma.invoice.findMany({
      select: {
        invoiceNo: true,
        salesman: true,
        totalAmount: true,
        isReturned: true,
        status: true,
      },
    });

    const enrichedEmployees = employees.map((emp) => {
      const matchedUser = users.find(
        (u) =>
          (emp.email && u.email && u.email.toLowerCase() === emp.email.toLowerCase()) ||
          (emp.empNo && emp.empNo.toLowerCase().includes(u.username.toLowerCase())) ||
          (u.fullName && emp.fullName && u.fullName.toLowerCase() === emp.fullName.toLowerCase())
      );

      const username = matchedUser ? matchedUser.username : emp.empNo.replace('EMP-', '').toLowerCase();
      const fullNameLower = (emp.fullName || '').toLowerCase();
      const empNoLower = (emp.empNo || '').toLowerCase();
      const usernameLower = username.toLowerCase();

      // Find active invoices matching this employee as salesman
      const matchedInvoices = allInvoices.filter((inv) => {
        if (!inv.salesman) return false;
        const s = inv.salesman.toLowerCase();
        return (
          s.includes(fullNameLower) ||
          s.includes(empNoLower) ||
          s.includes(usernameLower) ||
          (fullNameLower.includes(s) && s.length > 3)
        );
      });

      const activeInvoices = matchedInvoices.filter((inv) => !inv.isReturned && inv.status !== 'Returned');
      const returnedInvoices = matchedInvoices.filter((inv) => inv.isReturned || inv.status === 'Returned');

      const totalSalesVolume = activeInvoices.reduce((sum, inv) => sum + (inv.totalAmount || 0), 0);
      const returnedSalesVolume = returnedInvoices.reduce((sum, inv) => sum + (inv.totalAmount || 0), 0);
      const commissionRate = parseFloat(emp.commissionRate || (matchedUser ? matchedUser.commissionRate : 0) || 0);
      const liveCommission = totalSalesVolume * (commissionRate / 100);

      // Advances metrics (Taken, Deducted, Pending Balance)
      const allAdvances = emp.advances || [];
      const totalAdvancesTaken = allAdvances.reduce((sum, adv) => sum + (adv.amount || 0), 0);
      const totalAdvancesDeducted = allAdvances
        .filter((adv) => adv.status === 'DeductedInPayroll')
        .reduce((sum, adv) => sum + (adv.amount || 0), 0);
      const pendingAdvanceBalance = allAdvances
        .filter((adv) => adv.status === 'Approved' || adv.status === 'Pending')
        .reduce((sum, adv) => sum + (adv.amount || 0), 0);
      const remainingSalaryAfterAdvance = Math.max(0, (emp.basicSalary || 0) + liveCommission - pendingAdvanceBalance);

      return {
        ...emp,
        username,
        role: matchedUser ? matchedUser.role : emp.designation,
        permissions: matchedUser ? matchedUser.permissions : [],
        totalSalesVolume,
        returnedSalesVolume,
        activeInvoicesCount: activeInvoices.length,
        returnedInvoicesCount: returnedInvoices.length,
        liveCommission,
        totalAdvancesTaken,
        totalAdvancesDeducted,
        pendingAdvanceBalance,
        remainingSalaryAfterAdvance,
      };
    });

    res.json(enrichedEmployees);
  } catch (err) {
    console.error('Error fetching employees:', err);
    res.status(500).json({ error: 'Failed to fetch employee directory' });
  }
});

router.post('/employees', async (req, res) => {
  try {
    const { fullName, cnic, phone, email, designation, department, basicSalary, commissionRate, bankAccount, username, password } = req.body;
    if (!fullName) {
      return res.status(400).json({ error: 'Full Name is required' });
    }

    const sysUsername = username ? username.trim().toLowerCase() : fullName.split(' ')[0].toLowerCase() + Math.floor(Math.random() * 100);
    const count = await prisma.employee.count();
    const empNo = `EMP-${sysUsername.toUpperCase()}`;

    // 1. Create System User account in PostgreSQL
    let userRecord = await prisma.user.findUnique({ where: { username: sysUsername } });
    if (!userRecord) {
      userRecord = await prisma.user.create({
        data: {
          username: sysUsername,
          fullName,
          email: email || `${sysUsername}@pharmacareerp.com`,
          password: password || '123456',
          role: designation || 'Pharmacist',
          salary: parseFloat(basicSalary || 45000),
          commissionRate: parseFloat(commissionRate || 1.0),
          isActive: true,
        },
      });
    }

    // 2. Create Employee record in PostgreSQL
    const newEmp = await prisma.employee.create({
      data: {
        empNo,
        fullName,
        cnic: cnic || null,
        phone: phone || null,
        email: email || `${sysUsername}@pharmacareerp.com`,
        designation: designation || 'Pharmacist',
        department: department || 'Pharmacy Operations',
        basicSalary: parseFloat(basicSalary || 0),
        commissionRate: parseFloat(commissionRate || 0),
        bankAccount: bankAccount || null,
        isActive: true,
      },
    });

    res.status(201).json({
      ...newEmp,
      username: sysUsername,
      role: userRecord.role,
    });
  } catch (err) {
    console.error('Error creating employee:', err);
    res.status(500).json({ error: 'Failed to register employee' });
  }
});

router.put('/employees/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { fullName, cnic, phone, email, designation, department, basicSalary, commissionRate, bankAccount, isActive } = req.body;

    const updated = await prisma.employee.update({
      where: { id },
      data: {
        fullName,
        cnic,
        phone,
        email,
        designation,
        department,
        basicSalary: parseFloat(basicSalary || 0),
        commissionRate: parseFloat(commissionRate || 0),
        bankAccount,
        isActive: isActive !== undefined ? Boolean(isActive) : undefined,
      },
    });

    res.json(updated);
  } catch (err) {
    console.error('Error updating employee:', err);
    res.status(500).json({ error: 'Failed to update employee' });
  }
});

// ─────────────────────────────────────────────
// 2. ATTENDANCE TRACKING API
// ─────────────────────────────────────────────
router.get('/attendance', async (req, res) => {
  try {
    const { date } = req.query;
    let whereClause = {};

    if (date) {
      const targetDate = new Date(date);
      const startOfDay = new Date(targetDate.setHours(0, 0, 0, 0));
      const endOfDay = new Date(targetDate.setHours(23, 59, 59, 999));
      whereClause.date = { gte: startOfDay, lte: endOfDay };
    }

    const records = await prisma.attendance.findMany({
      where: whereClause,
      include: {
        employee: { select: { id: true, empNo: true, fullName: true, designation: true } },
      },
      orderBy: { date: 'desc' },
    });

    res.json(records);
  } catch (err) {
    console.error('Error fetching attendance:', err);
    res.status(500).json({ error: 'Failed to fetch attendance logs' });
  }
});

router.post('/attendance', async (req, res) => {
  try {
    const { employeeId, status, timeIn, timeOut, overtimeHrs, notes } = req.body;
    if (!employeeId) return res.status(400).json({ error: 'Employee ID is required' });

    const newRecord = await prisma.attendance.create({
      data: {
        employeeId,
        date: new Date(),
        status: status || 'Present',
        timeIn: timeIn || '09:00 AM',
        timeOut: timeOut || '06:00 PM',
        overtimeHrs: parseFloat(overtimeHrs || 0),
        notes: notes || null,
      },
      include: { employee: true },
    });

    res.status(201).json(newRecord);
  } catch (err) {
    console.error('Error logging attendance:', err);
    res.status(500).json({ error: 'Failed to log attendance' });
  }
});

// ─────────────────────────────────────────────
// 3. LEAVE REQUESTS API
// ─────────────────────────────────────────────
router.get('/leaves', async (req, res) => {
  try {
    const leaves = await prisma.leaveRequest.findMany({
      include: {
        employee: { select: { id: true, empNo: true, fullName: true, designation: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(leaves);
  } catch (err) {
    console.error('Error fetching leaves:', err);
    res.status(500).json({ error: 'Failed to fetch leave requests' });
  }
});

router.post('/leaves', async (req, res) => {
  try {
    const { employeeId, leaveType, startDate, endDate, reason } = req.body;
    if (!employeeId || !startDate || !endDate) {
      return res.status(400).json({ error: 'Employee, start date, and end date required' });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    const diffTime = Math.abs(end - start);
    const totalDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;

    const leave = await prisma.leaveRequest.create({
      data: {
        employeeId,
        leaveType: leaveType || 'Casual',
        startDate: start,
        endDate: end,
        totalDays: totalDays || 1,
        reason: reason || 'Personal Leave',
        status: 'Pending',
      },
      include: { employee: true },
    });

    res.status(201).json(leave);
  } catch (err) {
    console.error('Error creating leave request:', err);
    res.status(500).json({ error: 'Failed to submit leave request' });
  }
});

router.patch('/leaves/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['Pending', 'Approved', 'Rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const updated = await prisma.leaveRequest.update({
      where: { id },
      data: { status },
      include: { employee: true },
    });

    res.json(updated);
  } catch (err) {
    console.error('Error updating leave status:', err);
    res.status(500).json({ error: 'Failed to update leave status' });
  }
});

// ─────────────────────────────────────────────
// 4. SALARY ADVANCES & LOANS API
// ─────────────────────────────────────────────
router.get('/advances', async (req, res) => {
  try {
    const { employeeId, status } = req.query;
    let whereClause = {};
    if (employeeId) whereClause.employeeId = employeeId;
    if (status) whereClause.status = status;

    const advances = await prisma.salaryAdvance.findMany({
      where: whereClause,
      include: {
        employee: { select: { id: true, empNo: true, fullName: true, designation: true, basicSalary: true, bankAccount: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(advances);
  } catch (err) {
    console.error('Error fetching salary advances:', err);
    res.status(500).json({ error: 'Failed to fetch salary advances' });
  }
});

router.post('/advances', async (req, res) => {
  try {
    const { employeeId, amount, paymentMethod, reason, notes, requestDate } = req.body;
    if (!employeeId || !amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Employee and a valid advance amount are required' });
    }

    const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const advAmount = parseFloat(amount);
    const count = await prisma.salaryAdvance.count();
    const advanceNo = `ADV-${String(count + 1001)}`;
    const method = paymentMethod || 'Cash';

    // 1. Create SalaryAdvance Record
    const newAdvance = await prisma.salaryAdvance.create({
      data: {
        advanceNo,
        employeeId,
        amount: advAmount,
        requestDate: requestDate ? new Date(requestDate) : new Date(),
        disbursedDate: new Date(),
        reason: reason || 'Salary Advance Request',
        paymentMethod: method,
        status: 'Approved',
        notes: notes || null,
      },
      include: { employee: true },
    });

    // 2. Automatically log Salary Advance Expense Voucher in AccountTransaction
    const txCount = await prisma.accountTransaction.count();
    await prisma.accountTransaction.create({
      data: {
        voucherNo: `EV-${String(txCount + 1001)}`,
        transactionType: 'Expense',
        partyType: 'GeneralExpense',
        partyName: `Salary Advance (${emp.fullName})`,
        amount: advAmount,
        paymentMethod: method,
        referenceNo: advanceNo,
        description: `Advance on Salary Disbursed to ${emp.fullName} (${advanceNo}) - Reason: ${reason || 'Advance Request'}`,
      },
    });

    res.status(201).json(newAdvance);
  } catch (err) {
    console.error('Error creating salary advance:', err);
    res.status(500).json({ error: 'Failed to disburse salary advance' });
  }
});

router.delete('/advances/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const adv = await prisma.salaryAdvance.findUnique({ where: { id } });
    if (!adv) return res.status(404).json({ error: 'Salary advance record not found' });

    if (adv.status === 'DeductedInPayroll') {
      return res.status(400).json({ error: 'Cannot delete advance already deducted in payroll slip' });
    }

    await prisma.salaryAdvance.delete({ where: { id } });
    res.json({ message: 'Salary advance deleted successfully' });
  } catch (err) {
    console.error('Error deleting salary advance:', err);
    res.status(500).json({ error: 'Failed to delete salary advance' });
  }
});

// GET Full Advance History & Ledger Statement for an Employee
router.get('/employees/:id/advance-statement', async (req, res) => {
  try {
    const { id } = req.params;
    const emp = await prisma.employee.findUnique({
      where: { id },
      include: {
        advances: { orderBy: { createdAt: 'asc' } },
        payrolls: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    // Fetch user for username and permissions
    const matchedUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email: emp.email || undefined },
          { username: emp.empNo.replace('EMP-', '').toLowerCase() },
          { fullName: emp.fullName },
        ],
      },
    });

    // Build timeline of advance disbursements and deductions with running balance
    let runningAdvanceBalance = 0;
    const timeline = [];

    for (const adv of emp.advances) {
      runningAdvanceBalance += adv.amount;
      timeline.push({
        id: adv.id,
        date: adv.disbursedDate || adv.requestDate || adv.createdAt,
        type: 'AdvanceDisbursement',
        refNo: adv.advanceNo,
        description: adv.reason || 'Salary Advance Request',
        paymentMethod: adv.paymentMethod,
        debit: adv.amount, // Advance taken
        credit: 0,
        runningBalance: runningAdvanceBalance,
        status: adv.status,
        notes: adv.notes,
        payrollSlipNo: adv.payrollSlipNo,
      });

      if (adv.status === 'DeductedInPayroll') {
        runningAdvanceBalance -= adv.amount;
        timeline.push({
          id: `DED-${adv.id}`,
          date: adv.deductedAt || adv.updatedAt,
          type: 'PayrollDeduction',
          refNo: adv.payrollSlipNo || 'PAYROLL-DED',
          description: `Advance Recovery via Payroll Slip #${adv.payrollSlipNo || ''}`,
          paymentMethod: 'PayrollDeduction',
          debit: 0,
          credit: adv.amount, // Deducted in payroll
          runningBalance: runningAdvanceBalance,
          status: 'Settled',
          notes: `Deducted against Advance #${adv.advanceNo}`,
          payrollSlipNo: adv.payrollSlipNo,
        });
      }
    }

    // Sort timeline chronologically
    timeline.sort((a, b) => new Date(a.date) - new Date(b.date));

    const totalAdvancesTaken = emp.advances.reduce((sum, a) => sum + (a.amount || 0), 0);
    const totalAdvancesDeducted = emp.advances
      .filter((a) => a.status === 'DeductedInPayroll')
      .reduce((sum, a) => sum + (a.amount || 0), 0);
    const remainingAdvanceBalance = totalAdvancesTaken - totalAdvancesDeducted;

    // Calculate live commission from active invoices
    const allInvoices = await prisma.invoice.findMany({
      where: {
        OR: [
          { salesman: { contains: emp.fullName, mode: 'insensitive' } },
          { salesman: { contains: emp.empNo, mode: 'insensitive' } },
          { salesman: { contains: emp.empNo.replace('EMP-', ''), mode: 'insensitive' } },
        ],
      },
    });

    const activeInvoices = allInvoices.filter((inv) => !inv.isReturned && inv.status !== 'Returned');
    const totalSalesVolume = activeInvoices.reduce((sum, inv) => sum + (inv.totalAmount || 0), 0);
    const commissionRate = parseFloat(emp.commissionRate || 0);
    const liveCommission = totalSalesVolume * (commissionRate / 100);

    const netRemainingSalaryEstimate = Math.max(0, (emp.basicSalary || 0) + liveCommission - remainingAdvanceBalance);

    res.json({
      employee: {
        id: emp.id,
        empNo: emp.empNo,
        fullName: emp.fullName,
        username: matchedUser ? matchedUser.username : emp.empNo.replace('EMP-', '').toLowerCase(),
        designation: emp.designation,
        department: emp.department,
        basicSalary: emp.basicSalary,
        commissionRate: emp.commissionRate,
        phone: emp.phone,
        cnic: emp.cnic,
        bankAccount: emp.bankAccount,
        joiningDate: emp.joiningDate,
      },
      summary: {
        totalAdvancesTaken,
        totalAdvancesDeducted,
        remainingAdvanceBalance,
        advancesCount: emp.advances.length,
        pendingAdvancesCount: emp.advances.filter((a) => a.status !== 'DeductedInPayroll').length,
        basicSalary: emp.basicSalary,
        liveCommission,
        totalSalesVolume,
        activeInvoicesCount: activeInvoices.length,
        netRemainingSalaryEstimate,
      },
      timeline,
      advances: emp.advances,
      payrolls: emp.payrolls,
    });
  } catch (err) {
    console.error('Error fetching advance statement:', err);
    res.status(500).json({ error: 'Failed to fetch employee advance statement' });
  }
});

// ─────────────────────────────────────────────
// 5. SALES COMMISSION CALCULATION API
// ─────────────────────────────────────────────
router.get('/employees/:id/commission', async (req, res) => {
  try {
    const { id } = req.params;
    const { monthYear } = req.query; // Format YYYY-MM e.g., 2026-08

    const emp = await prisma.employee.findUnique({
      where: { id },
      include: { advances: true },
    });
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    // Date range filter
    let salesQuery = {};
    if (monthYear) {
      const [year, month] = monthYear.split('-');
      const startMonth = new Date(parseInt(year, 10), parseInt(month, 10) - 1, 1);
      const endMonth = new Date(parseInt(year, 10), parseInt(month, 10), 0, 23, 59, 59);

      salesQuery.createdAt = { gte: startMonth, lte: endMonth };
    }

    // Match invoice salesman by full name or empNo
    const allInvoices = await prisma.invoice.findMany({
      where: {
        ...salesQuery,
        OR: [
          { salesman: { contains: emp.fullName } },
          { salesman: { contains: emp.empNo } },
          { salesman: { contains: emp.empNo.replace('EMP-', '') } },
        ],
      },
    });

    const activeInvoices = allInvoices.filter((inv) => !inv.isReturned && inv.status !== 'Returned');
    const returnedInvoices = allInvoices.filter((inv) => inv.isReturned || inv.status === 'Returned');

    const totalSalesVolume = activeInvoices.reduce((sum, inv) => sum + (inv.totalAmount || 0), 0);
    const returnedSalesVolume = returnedInvoices.reduce((sum, inv) => sum + (inv.totalAmount || 0), 0);
    const calculatedCommission = totalSalesVolume * ((emp.commissionRate || 0) / 100);

    // Pending advance balance
    const approvedAdvances = (emp.advances || []).filter(
      (a) => a.status === 'Approved' || a.status === 'Pending'
    );
    const pendingAdvanceBalance = approvedAdvances.reduce((sum, a) => sum + (a.amount || 0), 0);

    res.json({
      employeeId: emp.id,
      employeeName: emp.fullName,
      monthYear: monthYear || 'All Time',
      commissionRate: emp.commissionRate,
      activeInvoicesCount: activeInvoices.length,
      returnedInvoicesCount: returnedInvoices.length,
      totalSalesVolume,
      returnedSalesVolume,
      calculatedCommission,
      pendingAdvanceBalance,
      approvedAdvances,
    });
  } catch (err) {
    console.error('Error calculating commission:', err);
    res.status(500).json({ error: 'Failed to calculate sales commission' });
  }
});

// ─────────────────────────────────────────────
// 6. PAYROLL GENERATION & SLIP ISSUANCE API
// ─────────────────────────────────────────────
router.get('/payrolls', async (req, res) => {
  try {
    const payrolls = await prisma.payroll.findMany({
      include: {
        employee: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(payrolls);
  } catch (err) {
    console.error('Error fetching payrolls:', err);
    res.status(500).json({ error: 'Failed to fetch payroll records' });
  }
});

router.post('/payrolls/generate', async (req, res) => {
  try {
    const { employeeId, monthYear, overtimePay, salesCommission, advanceDeduction, deductions } = req.body;
    if (!employeeId || !monthYear) {
      return res.status(400).json({ error: 'Employee ID and Month/Year (YYYY-MM) are required' });
    }

    const emp = await prisma.employee.findUnique({
      where: { id: employeeId },
      include: { advances: true },
    });
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    // Check if payroll already generated for this month
    const existing = await prisma.payroll.findFirst({
      where: { employeeId, monthYear },
    });

    if (existing) {
      return res.status(400).json({ error: `Payroll for ${emp.fullName} for ${monthYear} has already been generated (${existing.payrollNo}).` });
    }

    const count = await prisma.payroll.count();
    const payrollNo = `SLIP-${String(count + 1001)}`;

    const basic = emp.basicSalary || 0;
    const ot = parseFloat(overtimePay || 0);
    const comm = parseFloat(salesCommission || 0);
    const advDed = parseFloat(advanceDeduction || 0);
    const ded = parseFloat(deductions || 0);
    const netSalary = Math.max(0, basic + ot + comm - advDed - ded);

    const newPayroll = await prisma.payroll.create({
      data: {
        payrollNo,
        employeeId,
        monthYear,
        basicSalary: basic,
        overtimePay: ot,
        salesCommission: comm,
        advanceDeduction: advDed,
        deductions: ded,
        netSalary,
        paymentStatus: 'Unpaid',
      },
      include: { employee: true },
    });

    // If advance deduction was applied, mark approved advances as DeductedInPayroll
    if (advDed > 0) {
      let remainingDeduction = advDed;
      const approvedAdvances = (emp.advances || [])
        .filter((a) => a.status === 'Approved' || a.status === 'Pending')
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

      for (const adv of approvedAdvances) {
        if (remainingDeduction <= 0) break;
        await prisma.salaryAdvance.update({
          where: { id: adv.id },
          data: {
            status: 'DeductedInPayroll',
            deductedAt: new Date(),
            payrollSlipNo: payrollNo,
          },
        });
        remainingDeduction -= adv.amount;
      }
    }

    res.status(201).json(newPayroll);
  } catch (err) {
    console.error('Error generating payroll:', err);
    res.status(500).json({ error: 'Failed to generate payroll slip' });
  }
});

// Post Salary Payment & Log Expense Voucher
router.post('/payrolls/:id/pay', async (req, res) => {
  try {
    const { id } = req.params;
    const { paymentMethod } = req.body;

    const payroll = await prisma.payroll.findUnique({
      where: { id },
      include: { employee: true },
    });

    if (!payroll) return res.status(404).json({ error: 'Payroll record not found' });

    if (payroll.paymentStatus === 'Paid') {
      return res.status(400).json({ error: 'Payroll has already been marked as Paid' });
    }

    // Update payroll status to Paid
    const updatedPayroll = await prisma.payroll.update({
      where: { id },
      data: {
        paymentStatus: 'Paid',
        paymentDate: new Date(),
        paymentMethod: paymentMethod || 'BankTransfer',
      },
      include: { employee: true },
    });

    // Automatically post Salary Expense Voucher in AccountTransaction!
    const count = await prisma.accountTransaction.count();
    await prisma.accountTransaction.create({
      data: {
        voucherNo: `EV-${String(count + 1001)}`,
        transactionType: 'Expense',
        partyType: 'GeneralExpense',
        partyName: `Salary Payment (${payroll.employee ? payroll.employee.fullName : 'Employee'})`,
        amount: payroll.netSalary,
        paymentMethod: paymentMethod || 'BankTransfer',
        referenceNo: payroll.payrollNo,
        description: `Monthly Salary Disbursement for ${payroll.monthYear} (${payroll.payrollNo}) - Net: Rs. ${payroll.netSalary}`,
      },
    });

    res.json(updatedPayroll);
  } catch (err) {
    console.error('Error processing salary payment:', err);
    res.status(500).json({ error: 'Failed to process salary payment' });
  }
});

// ─────────────────────────────────────────────
// 7. STORE OWNER PROFIT & DRAWINGS (ADMIN PROFIT SYSTEM)
// ─────────────────────────────────────────────
router.get('/owner-profit-summary', async (req, res) => {
  try {
    const { startDate, endDate, monthYear } = req.query;

    // Determine target month/year (defaults to current month if not specified)
    const now = new Date();
    const currentMonthYear = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const selectedMonth = monthYear || currentMonthYear;

    // Helper: Build Date range for month
    const [selYear, selMonth] = selectedMonth.split('-');
    const selStart = new Date(parseInt(selYear, 10), parseInt(selMonth, 10) - 1, 1, 0, 0, 0, 0);
    const selEnd = new Date(parseInt(selYear, 10), parseInt(selMonth, 10), 0, 23, 59, 59, 999);

    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const monthLabel = `${monthNames[parseInt(selMonth, 10) - 1]} ${selYear}`;

    // Custom date filters if passed
    let customStart = null;
    let customEnd = null;
    if (startDate && endDate) {
      customStart = new Date(`${startDate}T00:00:00.000Z`);
      customEnd = new Date(`${endDate}T23:59:59.999Z`);
    }

    // 1. Fetch ALL Invoices with items & products for accurate historical and period COGS and Profit
    const allInvoices = await prisma.invoice.findMany({
      include: {
        items: {
          include: {
            product: true,
          },
        },
      },
    });

    // 2. Fetch ALL Transactions for historical & period expenses and liquidity
    const allTransactions = await prisma.accountTransaction.findMany({
      orderBy: { transactionDate: 'desc' },
    });

    // Helper to calculate invoice COGS
    const calculateInvoiceCost = (inv) => {
      let invCost = 0;
      (inv.items || []).forEach((item) => {
        const storedCost = (item.costPrice !== undefined && item.costPrice !== null && Number(item.costPrice) > 0)
          ? Number(item.costPrice)
          : (item.product ? (item.product.costPrice || (item.product.tradePrice * 0.85)) : (item.stp * 0.85));
        const q = item.quantity || 1;
        const b = item.bonus || 0;
        const totalUnits = q + b;
        const stpVal = Number(item.stp || (item.product ? item.product.tradePrice : 0)) || 0;

        let itemCostTotal = storedCost * totalUnits;
        if (b > 0 && q > 0 && totalUnits > 0 && stpVal > 0) {
          const paidRatio = q / totalUnits;
          if ((storedCost / stpVal) > (paidRatio * 1.15)) {
            itemCostTotal = storedCost * q;
          }
        }
        invCost += itemCostTotal;
      });
      return invCost;
    };

    // Calculate All-Time & Monthly Buckets
    let allTimeGrossSales = 0;
    let allTimeGrossCost = 0;
    let allTimeReturnedSales = 0;
    let allTimeReturnedCost = 0;

    let periodGrossSales = 0;
    let periodGrossCost = 0;
    let periodReturnedSales = 0;
    let periodReturnedCost = 0;
    let periodActiveInvoicesCount = 0;
    let periodReturnedInvoicesCount = 0;

    // Monthly historical map: { 'YYYY-MM': { grossSales, returnedSales, grossCost, returnedCost, expenses, profitTaken, drawingsCount } }
    const monthlyMap = {};

    allInvoices.forEach((inv) => {
      const isRet = Boolean(inv.isReturned || inv.status === 'Returned');
      const invRev = inv.totalAmount || 0;
      const invCost = calculateInvoiceCost(inv);
      const invDate = new Date(inv.createdAt);
      const mKey = `${invDate.getFullYear()}-${String(invDate.getMonth() + 1).padStart(2, '0')}`;

      if (!monthlyMap[mKey]) {
        monthlyMap[mKey] = {
          monthYear: mKey,
          year: invDate.getFullYear(),
          month: invDate.getMonth() + 1,
          grossSales: 0,
          returnedSales: 0,
          grossCost: 0,
          returnedCost: 0,
          expenses: 0,
          salaryExpenses: 0,
          profitTaken: 0,
          drawingsCount: 0,
          invoicesCount: 0,
        };
      }

      monthlyMap[mKey].invoicesCount += 1;

      if (isRet) {
        allTimeReturnedSales += invRev;
        allTimeReturnedCost += invCost;
        monthlyMap[mKey].returnedSales += invRev;
        monthlyMap[mKey].returnedCost += invCost;
      } else {
        allTimeGrossSales += invRev;
        allTimeGrossCost += invCost;
        monthlyMap[mKey].grossSales += invRev;
        monthlyMap[mKey].grossCost += invCost;
      }

      // Check if inside selected period
      const inSelectedPeriod = customStart && customEnd
        ? invDate >= customStart && invDate <= customEnd
        : invDate >= selStart && invDate <= selEnd;

      if (inSelectedPeriod) {
        if (isRet) {
          periodReturnedSales += invRev;
          periodReturnedCost += invCost;
          periodReturnedInvoicesCount += 1;
        } else {
          periodGrossSales += invRev;
          periodGrossCost += invCost;
          periodActiveInvoicesCount += 1;
        }
      }
    });

    // 3. Process Account Transactions for Operating Expenses & Profit Withdrawals
    let allTimeGeneralExpenses = 0;
    let allTimeSalaryExpenses = 0;
    let periodGeneralExpenses = 0;
    let periodSalaryExpenses = 0;

    let allTimeProfitTaken = 0;
    let allTimeCashProfitTaken = 0;
    let allTimeBankProfitTaken = 0;
    let periodProfitTaken = 0;
    let periodCashProfitTaken = 0;
    let periodBankProfitTaken = 0;
    let periodDrawingsCount = 0;

    // Liquidity trackers
    let totalCashIn = 0;
    let totalCashOut = 0;
    let totalBankIn = 0;
    let totalBankOut = 0;

    const allProfitWithdrawalTxs = [];

    allTransactions.forEach((tx) => {
      if (tx.referenceNo === 'CANCELLED' || (tx.description && tx.description.includes('[DELETED'))) return;
      const amt = tx.amount || 0;
      const txDate = new Date(tx.transactionDate || tx.createdAt);
      const mKey = `${txDate.getFullYear()}-${String(txDate.getMonth() + 1).padStart(2, '0')}`;
      const m = (tx.paymentMethod || 'Cash').toLowerCase();
      const isBank = m.includes('bank') || m.includes('card') || m.includes('online') || m.includes('ibft') || m.includes('cheque');

      if (!monthlyMap[mKey]) {
        monthlyMap[mKey] = {
          monthYear: mKey,
          year: txDate.getFullYear(),
          month: txDate.getMonth() + 1,
          grossSales: 0,
          returnedSales: 0,
          grossCost: 0,
          returnedCost: 0,
          expenses: 0,
          salaryExpenses: 0,
          profitTaken: 0,
          drawingsCount: 0,
          invoicesCount: 0,
        };
      }

      // Check if inside selected period
      const inSelectedPeriod = customStart && customEnd
        ? txDate >= customStart && txDate <= customEnd
        : txDate >= selStart && txDate <= selEnd;

      // Expenses
      if (tx.transactionType === 'Expense') {
        allTimeGeneralExpenses += amt;
        monthlyMap[mKey].expenses += amt;

        if (tx.partyName && tx.partyName.toLowerCase().includes('salary')) {
          allTimeSalaryExpenses += amt;
          monthlyMap[mKey].salaryExpenses += amt;
        }

        if (inSelectedPeriod) {
          periodGeneralExpenses += amt;
          if (tx.partyName && tx.partyName.toLowerCase().includes('salary')) {
            periodSalaryExpenses += amt;
          }
        }
      }

      // Profit Withdrawals
      if (tx.transactionType === 'ProfitWithdrawal' || tx.transactionType === 'OwnerDrawing') {
        allProfitWithdrawalTxs.push(tx);
        allTimeProfitTaken += amt;
        monthlyMap[mKey].profitTaken += amt;
        monthlyMap[mKey].drawingsCount += 1;

        if (isBank) allTimeBankProfitTaken += amt;
        else allTimeCashProfitTaken += amt;

        if (inSelectedPeriod) {
          periodProfitTaken += amt;
          periodDrawingsCount += 1;
          if (isBank) periodBankProfitTaken += amt;
          else periodCashProfitTaken += amt;
        }
      }

      // Liquidity calculation
      if (tx.transactionType === 'CustomerReceipt' || tx.transactionType === 'OwnerInvestment') {
        if (isBank) totalBankIn += amt;
        else totalCashIn += amt;
      } else if (
        tx.transactionType === 'SupplierPayment' ||
        tx.transactionType === 'Expense' ||
        tx.transactionType === 'OwnerDrawing' ||
        tx.transactionType === 'ProfitWithdrawal' ||
        tx.transactionType === 'CapitalWithdrawal'
      ) {
        if (isBank) totalBankOut += amt;
        else totalCashOut += amt;
      }
    });

    const cashInHand = Math.max(0, totalCashIn - totalCashOut);
    const bankBalance = totalBankIn - totalBankOut;

    // 4. Period Calculations
    const periodNetSales = periodGrossSales - periodReturnedSales;
    const periodNetCost = periodGrossCost - periodReturnedCost;
    const periodGrossProfit = periodNetSales - periodNetCost;
    const periodGrossMargin = periodNetSales > 0 ? ((periodGrossProfit / periodNetSales) * 100).toFixed(2) : '0.00';
    const periodNetProfit = Math.round((periodGrossProfit - periodGeneralExpenses) * 100) / 100;
    const periodNetMargin = periodNetSales > 0 ? ((periodNetProfit / periodNetSales) * 100).toFixed(2) : '0.00';
    const periodRetainedProfit = Math.round((periodNetProfit - periodProfitTaken) * 100) / 100;
    const periodUtilizationRate = periodNetProfit > 0 ? Math.min(100, Math.round((periodProfitTaken / periodNetProfit) * 100)) : 0;

    // 5. All-Time Calculations
    const allTimeNetSales = allTimeGrossSales - allTimeReturnedSales;
    const allTimeNetCost = allTimeGrossCost - allTimeReturnedCost;
    const allTimeGrossProfit = allTimeNetSales - allTimeNetCost;
    const allTimeGrossMargin = allTimeNetSales > 0 ? ((allTimeGrossProfit / allTimeNetSales) * 100).toFixed(2) : '0.00';
    const allTimeNetProfit = Math.round((allTimeGrossProfit - allTimeGeneralExpenses) * 100) / 100;
    const allTimeNetMargin = allTimeNetSales > 0 ? ((allTimeNetProfit / allTimeNetSales) * 100).toFixed(2) : '0.00';
    const allTimeRetainedProfit = Math.round((allTimeNetProfit - allTimeProfitTaken) * 100) / 100;

    // 6. Build Monthly History Summary Array
    const monthlyHistory = Object.keys(monthlyMap)
      .sort((a, b) => b.localeCompare(a))
      .map((k) => {
        const mObj = monthlyMap[k];
        const netSales = mObj.grossSales - mObj.returnedSales;
        const cogs = mObj.grossCost - mObj.returnedCost;
        const grossProfit = netSales - cogs;
        const netProfit = Math.round((grossProfit - mObj.expenses) * 100) / 100;
        const retained = Math.round((netProfit - mObj.profitTaken) * 100) / 100;
        const mName = monthNames[mObj.month - 1] || 'Month';
        return {
          monthYear: k,
          monthLabel: `${mName} ${mObj.year}`,
          year: mObj.year,
          month: mObj.month,
          invoicesCount: mObj.invoicesCount,
          netSales,
          cogs,
          grossProfit,
          grossMarginPercent: netSales > 0 ? ((grossProfit / netSales) * 100).toFixed(1) : '0.0',
          operatingExpenses: mObj.expenses,
          salaryExpenses: mObj.salaryExpenses,
          netProfit,
          netMarginPercent: netSales > 0 ? ((netProfit / netSales) * 100).toFixed(1) : '0.0',
          profitTaken: mObj.profitTaken,
          retainedProfit: retained,
          drawingsCount: mObj.drawingsCount,
        };
      });

    // 7. Build Permanent Chronological Audit Ledger of All Drawings
    const sortedDrawings = [...allProfitWithdrawalTxs].sort((a, b) => new Date(a.transactionDate) - new Date(b.transactionDate));
    let runningTakenAccumulator = 0;

    const timeline = sortedDrawings.map((tx) => {
      runningTakenAccumulator += tx.amount || 0;
      const runningRemaining = allTimeNetProfit - runningTakenAccumulator;
      return {
        id: tx.id,
        date: tx.transactionDate,
        voucherNo: tx.voucherNo,
        transactionType: tx.transactionType,
        description: tx.description,
        partyName: tx.partyName || 'Store Owner (Admin)',
        paymentMethod: tx.paymentMethod,
        amountTaken: tx.amount,
        cumulativeProfitTaken: runningTakenAccumulator,
        runningRemainingProfit: runningRemaining,
        referenceNo: tx.referenceNo,
        isPermanent: true,
        auditStatus: 'VERIFIED_PERMANENT_VOUCHER',
      };
    });

    timeline.reverse();

    // 8. Find Admin profile
    const adminUser = await prisma.user.findFirst({
      where: { role: 'Admin' },
      select: { id: true, username: true, fullName: true, email: true, role: true },
    });

    res.json({
      adminUser: adminUser || { username: 'admin', fullName: 'System Administrator', role: 'Admin' },
      selectedPeriod: {
        monthYear: selectedMonth,
        monthLabel,
        isCustomRange: Boolean(startDate && endDate),
        startDate: startDate || selStart.toISOString().split('T')[0],
        endDate: endDate || selEnd.toISOString().split('T')[0],
      },
      periodMetrics: {
        grossSales: periodGrossSales,
        returnedSales: periodReturnedSales,
        netSalesRevenue: periodNetSales,
        netCostOfGoods: periodNetCost,
        storeGrossProfit: periodGrossProfit,
        grossProfitMarginPercent: parseFloat(periodGrossMargin),
        totalGeneralExpenses: periodGeneralExpenses,
        totalSalaryExpenses: periodSalaryExpenses,
        storeNetProfit: periodNetProfit,
        netProfit: periodNetProfit,
        netProfitMarginPercent: parseFloat(periodNetMargin),
        profitTaken: periodProfitTaken,
        cashProfitTaken: periodCashProfitTaken,
        bankProfitTaken: periodBankProfitTaken,
        retainedProfit: periodRetainedProfit,
        remainingStoreProfit: periodRetainedProfit,
        profitUtilizationRate: periodUtilizationRate,
        drawingsCount: periodDrawingsCount,
        activeInvoicesCount: periodActiveInvoicesCount,
        returnedInvoicesCount: periodReturnedInvoicesCount,
      },
      allTimeMetrics: {
        netSalesRevenue: allTimeNetSales,
        netCostOfGoods: allTimeNetCost,
        storeGrossProfit: allTimeGrossProfit,
        grossProfitMarginPercent: parseFloat(allTimeGrossMargin),
        totalGeneralExpenses: allTimeGeneralExpenses,
        totalSalaryExpenses: allTimeSalaryExpenses,
        storeNetProfit: allTimeNetProfit,
        totalNetProfit: allTimeNetProfit,
        netProfitMarginPercent: parseFloat(allTimeNetMargin),
        totalProfitTaken: allTimeProfitTaken,
        totalCashProfitTaken: allTimeCashProfitTaken,
        totalBankProfitTaken: allTimeBankProfitTaken,
        remainingStoreProfit: allTimeRetainedProfit,
        remainingRetainedProfit: allTimeRetainedProfit,
        cashInHand,
        bankBalance,
        totalDrawingsCount: allProfitWithdrawalTxs.length,
      },
      metrics: {
        netSalesRevenue: allTimeNetSales,
        netCostOfGoods: allTimeNetCost,
        storeGrossProfit: allTimeGrossProfit,
        grossProfitMarginPercent: parseFloat(allTimeGrossMargin),
        totalGeneralExpenses: allTimeGeneralExpenses,
        totalSalaryExpenses: allTimeSalaryExpenses,
        storeNetProfit: allTimeNetProfit,
        totalNetProfit: allTimeNetProfit,
        netProfitMarginPercent: parseFloat(allTimeNetMargin),
        totalProfitTaken: allTimeProfitTaken,
        totalCashProfitTaken: allTimeCashProfitTaken,
        totalBankProfitTaken: allTimeBankProfitTaken,
        remainingStoreProfit: allTimeRetainedProfit,
        remainingRetainedProfit: allTimeRetainedProfit,
        cashInHand,
        bankBalance,
        totalDrawingsCount: allProfitWithdrawalTxs.length,
      },
      monthlyHistory,
      timeline,
    });
  } catch (err) {
    console.error('Error fetching owner profit summary:', err);
    res.status(500).json({ error: 'Failed to fetch owner profit summary', details: err.message });
  }
});

// Record Owner Profit Drawing / Profit Taken (Permanent Audit Record)
router.post('/owner-drawings', async (req, res) => {
  try {
    const { amount, paymentMethod, reason, notes, date, referenceNo } = req.body;
    const parsedAmt = parseFloat(amount);

    if (isNaN(parsedAmt) || parsedAmt <= 0) {
      return res.status(400).json({ error: 'Please enter a valid profit withdrawal amount greater than 0' });
    }

    const method = paymentMethod || 'Cash';
    const isBank = method.toLowerCase().includes('bank') || method.toLowerCase().includes('card') || method.toLowerCase().includes('online') || method.toLowerCase().includes('ibft') || method.toLowerCase().includes('cheque');

    // 1. Check Cash/Bank Liquidity
    const allTransactions = await prisma.accountTransaction.findMany();
    let totalCashIn = 0;
    let totalCashOut = 0;
    let totalBankIn = 0;
    let totalBankOut = 0;

    allTransactions.forEach((tx) => {
      if (tx.referenceNo === 'CANCELLED' || (tx.description && tx.description.includes('[DELETED'))) return;
      const amt = tx.amount || 0;
      const m = (tx.paymentMethod || 'Cash').toLowerCase();
      const txIsBank = m.includes('bank') || m.includes('card') || m.includes('online') || m.includes('ibft') || m.includes('cheque');

      if (tx.transactionType === 'CustomerReceipt' || tx.transactionType === 'OwnerInvestment') {
        if (txIsBank) totalBankIn += amt;
        else totalCashIn += amt;
      } else if (
        tx.transactionType === 'SupplierPayment' ||
        tx.transactionType === 'Expense' ||
        tx.transactionType === 'OwnerDrawing' ||
        tx.transactionType === 'ProfitWithdrawal' ||
        tx.transactionType === 'CapitalWithdrawal'
      ) {
        if (txIsBank) totalBankOut += amt;
        else totalCashOut += amt;
      }
    });

    const cashInHand = Math.max(0, totalCashIn - totalCashOut);
    const bankBalance = totalBankIn - totalBankOut;

    if (!isBank && parsedAmt > cashInHand) {
      return res.status(400).json({
        error: `Insufficient Cash in Till! Available Counter Cash: Rs. ${cashInHand.toLocaleString()}, but withdrawal request is Rs. ${parsedAmt.toLocaleString()}`,
      });
    }

    if (isBank && parsedAmt > bankBalance) {
      return res.status(400).json({
        error: `Insufficient Bank Funds! Available Bank Balance: Rs. ${bankBalance.toLocaleString()}, but withdrawal request is Rs. ${parsedAmt.toLocaleString()}`,
      });
    }

    // 2. Generate Permanent OPW-XXXX Voucher Number
    const count = await prisma.accountTransaction.count();
    const voucherNo = `OPW-${String(count + 1001)}`;

    const txDate = date ? new Date(date) : new Date();
    const drawingDesc = reason 
      ? `Owner Profit Withdrawal: ${reason}${notes ? ` - ${notes}` : ''}`
      : `Store Owner (Admin) Profit Distribution (${voucherNo})`;

    const newTx = await prisma.accountTransaction.create({
      data: {
        voucherNo,
        transactionType: 'ProfitWithdrawal',
        partyType: 'OwnerDrawing',
        partyName: 'Store Owner (Admin)',
        amount: parsedAmt,
        paymentMethod: method,
        referenceNo: referenceNo || voucherNo,
        description: drawingDesc,
        transactionDate: txDate,
      },
    });

    res.status(201).json({
      message: `Permanent Owner Profit Drawing Voucher ${voucherNo} recorded successfully`,
      transaction: newTx,
    });
  } catch (err) {
    console.error('Error recording owner profit withdrawal:', err);
    res.status(500).json({ error: 'Failed to record owner profit withdrawal' });
  }
});

// Non-deletable voucher safeguard - Permanent Audit Trail
router.delete('/owner-drawings/:id', async (req, res) => {
  return res.status(403).json({
    error: 'PROHIBITED: Store Owner Profit Drawing Vouchers are permanent, immutable audit-trail accounting vouchers and cannot be deleted or tampered with.',
  });
});

module.exports = router;

