import sharp from 'sharp';
import {readFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const output=join(process.env.LOCALAPPDATA??tmpdir(),'OpenGEO','brand-review');mkdirSync(output,{recursive:true});
const sizes=[16,24,32,64],composites=[];
for(const [row,name]of ['symbol','symbol-ink','symbol-white'].entries())for(const [column,size]of sizes.entries()){const image=await sharp(readFileSync('assets/'+name+'.svg')).resize(size,size).png().toBuffer();composites.push({input:image,left:column*120+60-Math.floor(size/2),top:row*100+50-Math.floor(size/2)})}
const background=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><rect width="480" height="300" fill="#fff"/><rect y="200" width="480" height="100" fill="#0f172a"/></svg>');
await sharp(background).composite(composites).png().toFile(join(output,'logo-size-review.png'));
console.log('Logo size review: '+join(output,'logo-size-review.png'));
