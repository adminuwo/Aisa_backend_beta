import axios from 'axios';

async function test() {
    try {
        const rawUrl = 'https://storage.googleapis.com/aisa_objects/generated_images/aisa_gen_1776160785470.png?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=video-signer%40ai-mall-484810.iam.gserviceaccount.com%2F20260414%2Fauto%2Fstorage%2Fgoog4_request&X-Goog-Date=20260414T095947Z&X-Goog-Expires=604800&X-Goog-SignedHeaders=host&X-Goog-Signature=ce49b906ffa2b929f2fd2a72d9e45b2a1c9b7971d21fde631c8b44c45d8bc77fff708b950109e30d0b59ead100f3b6c32449af17e32dd144bf5288799c819c4338f3e5beb0e7042b71bc0de85b4dcde09e38ba0df16b0081a07f6524b4f6ca7aa2217303099e11ed40003f7379558a72b36fef5a2cd869278553e49e39dffb803ca3e38c923cc79923ad82f8280357c6d7bda9861ed837496cbb88a8ae7d9cdd7d43813ee8d2a849e3da865f0728365bee61cc5310211f4998839fd5576da4eff6d9e34a7af3f3a9fbf2fbf27a0d62ee682cf2edff4d969a80323f0cbdf1faec090a633a41bf9839a39e6657990f74646c60ac2733cfb3308495b8f98387052e';
        const target = `http://localhost:8080/api/image/proxy?url=${encodeURIComponent(rawUrl)}`;
        const res = await axios.get(target);
        console.log("Success! Status:", res.status);
    } catch (e) {
        console.error("Error:", e.message);
        if (e.response) {
            console.error("Status:", e.response.status);
            console.error("Data:", e.response.data);
        }
    }
}
test();
