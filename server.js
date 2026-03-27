// 📄 SERVIR ARCHIVOS HTML
// ═══════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard-standalone.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});  // 📄 SERVIR ARCHIVOS HTML
// ═══════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard-standalone.html'));
});

app.get('/dashboard-standalone.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard-standalone.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});
