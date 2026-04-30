import puppeteer from 'puppeteer';

async function test() {
    try {
        console.log("Launching browser...");
        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox']
        });
        console.log("Browser launched successfully!");
        const page = await browser.newPage();
        await page.setContent('<h1>Hello World</h1>');
        const pdf = await page.pdf({ format: 'A4' });
        console.log("PDF generated successfully! Size:", pdf.length);
        await browser.close();
    } catch (error) {
        console.error("Puppeteer test failed:", error);
    }
}

test();
