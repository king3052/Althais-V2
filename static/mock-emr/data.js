// Synthetic claims for testing the Althais extension. No real patients. Dates are relative to today.
(function () {
  function d(daysAgo) { var t = new Date(Date.now() - daysAgo * 864e5); return ("0" + (t.getMonth() + 1)).slice(-2) + "/" + ("0" + t.getDate()).slice(-2) + "/" + t.getFullYear(); }
  window.MOCK_CLAIMS = [
    { id: "50001", expect: "Clean", note: "Chest pain workup, everything filled in", patient: "TESTPATIENT, ALPHA", dob: "01/31/1980", dos: d(3), payer: "Aetna PPO", provider: "Test Provider MD", pos: "23",
      dx: [["R07.9", "Chest pain, unspecified"], ["R06.00", "Dyspnea, unspecified"]], lines: [["99284", "", "", "1,2", 1, 450], ["93005", "", "", "1", 1, 75]] },
    { id: "50002", expect: "Fix first: no diagnosis", note: "Diagnosis was never added", patient: "TESTPATIENT, BRAVO", dob: "06/02/1975", dos: d(5), payer: "Cigna", provider: "Test Provider MD", pos: "20",
      dx: [], lines: [["99213", "", "", "", 1, 120]] },
    { id: "50003", expect: "Fix first: bad ICD-10", note: "An old ICD-9 code was typed in", patient: "TESTPATIENT, CHARLIE", dob: "11/11/1990", dos: d(4), payer: "UnitedHealthcare", provider: "Test Provider MD", pos: "23",
      dx: [["7865", "Chest pain (ICD-9, not valid)"]], lines: [["99283", "", "", "1", 1, 280]] },
    { id: "50004", expect: "Worth a look: NCCI bundling", note: "Injection billed with an ER visit, no modifier", patient: "TESTPATIENT, DELTA", dob: "03/15/1968", dos: d(2), payer: "Blue Cross Blue Shield of Texas", provider: "Test Provider MD", pos: "23",
      dx: [["M54.50", "Low back pain, unspecified"]], lines: [["96372", "", "", "1", 1, 60], ["99284", "", "", "1", 1, 450]] },
    { id: "50005", expect: "Worth a look: zero charge", note: "Fee schedule didn't load", patient: "TESTPATIENT, ECHO", dob: "08/08/2001", dos: d(1), payer: "Medicare Part B", provider: "Test Provider MD", pos: "20",
      dx: [["J02.9", "Acute pharyngitis, unspecified"]], lines: [["99213", "", "", "1", 1, 0]] },
    { id: "50006", expect: "Worth a look: aging", note: "Visit from about 200 days ago, never sent", patient: "TESTPATIENT, FOXTROT", dob: "02/29/1984", dos: d(200), payer: "Humana", provider: "Test Provider MD", pos: "20",
      dx: [["S93.401A", "Sprain of unspecified ligament of right ankle, initial"]], lines: [["99214", "25", "", "1", 1, 160], ["29540", "", "", "1", 1, 55]] },
    { id: "50007", expect: "Fix first: no payer", note: "Insurance was never attached", patient: "TESTPATIENT, GOLF", dob: "12/24/1995", dos: d(6), payer: "", provider: "Test Provider MD", pos: "20",
      dx: [["N39.0", "Urinary tract infection, site not specified"]], lines: [["99213", "", "", "1", 1, 120], ["81003", "", "", "1", 1, 15]] }
  ];
})();
