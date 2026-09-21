const test = require('node:test'); const assert = require('node:assert/strict');
const {episodeGaps}=require('../electron/episodeGaps');
test('missing rows exclude owned files, duplicates and unnumbered files',()=>{
 const own=[{season:1,episode:1},{season:1,episode:1},{season:1,episode:3},{season:null,episode:null}];
 const before=JSON.stringify(own);const gaps=episodeGaps(own,[{season_number:1,episode_count:4}],{'1|2':'Campfire'});
 assert.deepEqual(gaps.get(1),{checked:true,items:[{season:1,episode:2,title:'S1E2 · Campfire'},{season:1,episode:4,title:'S1E4'}]});
 assert.equal(JSON.stringify(own),before);assert.equal(gaps.size,1);
});
test('unavailable metadata never invents missing episodes or completeness',()=>{
 assert.deepEqual(episodeGaps([{season:2,episode:3}],undefined).get(2),{checked:false,items:[]});
 assert.equal(episodeGaps([{season:1,episode:1}],[{season_number:1,episode_count:Infinity}]).get(1).checked,false);
});
test('known episode names can identify gaps without a TMDB key',()=>{
 const gap=episodeGaps([{season:1,episode:1}],null,{'1|1':'Home','1|3':'Lake','1|5':'Night','2|1':'Another season','1|NaN':'bad'}).get(1);
 assert.deepEqual(gap.items.map(x=>x.episode),[3,5]);assert.equal(gap.checked,true);
});
