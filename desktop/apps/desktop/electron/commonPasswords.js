'use strict'
// A small offline list of passwords that show up at the top of every breach dump. It is
// bundled (no network, no third-party lookup) and checked in passwordPolicy.js, which
// also catches the obvious tweaks (capital letter, trailing digits, 4 -> a, 0 -> o).
// This is a speed bump for the worst passwords, not a substitute for a long passphrase.
const WORDS = `
password passw0rd password1 password12 password123 password1234 pass word1 letmein letmein1 welcome welcome1 welcome123
admin admin123 administrator root toor changeme default guest test test123 testing qwerty qwerty1 qwerty12 qwerty123 qwertyuiop
qwertyui asdfgh asdfghjk asdfghjkl asdf1234 zxcvbn zxcvbnm zxcvbnm1 1qaz2wsx 1qazxsw2 qazwsx qazwsxedc zaq12wsx
abc123 abc1234 abcd1234 abcdefg abcdefgh abcdef abcde 123abc a1b2c3 a1b2c3d4 aaaaaa aaaaaaaa
iloveyou iloveyou1 iloveu ilovegod ilovemom loveyou lovely love123 lovers sweetheart babygirl babyboy princess princess1
monkey monkey123 dragon dragon123 master master123 shadow shadow1 sunshine sunshine1 superman batman spiderman ironman
football football1 baseball basketball hockey soccer golfer tennis runner biker fishing hunter
trustno1 whatever freedom secret secret123 access hello hello123 hellohello login login123 fuckyou fuckyou1
michael jennifer jessica ashley amanda nicole daniel andrew joshua matthew jordan thomas charlie robert george harley
jesus christ heaven angel angels blessed forever family friends friend buddy bubbles butterfly
computer internet google facebook twitter youtube netflix amazon apple samsung windows windows10 microsoft
starwars startrek pokemon naruto minecraft fortnite roblox mario zelda matrix gandalf hobbit harrypotter
summer winter spring autumn august january monday sunday
mustang corvette ferrari porsche mercedes bmw toyota honda camaro chevy
cheese chocolate cookie cookies pepper ginger peanut banana orange purple yellow silver golden diamond
hunter2 hunter1 killer ranger marine soldier tigger tiger tigers eagle eagles panther lion wolf wolves cowboy cowboys
pass1234 pass123 passpass passwd password! passw0rd1 p@ssw0rd p@ssword p@ssw0rd1 pa55word pa55w0rd
1q2w3e 1q2w3e4r 1q2w3e4r5t 1q2w3e4r5t6y q1w2e3r4 q1w2e3r4t5 q1w2e3 1qaz2wsx3edc zxcv1234 zxcvbnm123
iloveyou2 princess123 monkey1 dragon1 sunshine123 football123 baseball1 basketball1
beebo beebo123 beebo1234 beeboentertainment movies movies123 movie123 movienight plex plex123 plexpass jellyfin
family123 home homeserver mediaserver media123 mediaserver1
000000 00000000 111111 11111111 121212 123123 1231234 123321 123456 1234567 12345678 123456789 1234567890 12345678910
1qaz 654321 666666 696969 7777777 777777 888888 987654321 987654 999999 112233 101010 159753 147258369 741852963
abcdefghi 0987654321 1234qwer 1234abcd 12341234 123qwe 123qweasd 123qwe123 123asd 123asdf 123456a 123456q a123456 a1234567
qweasd qweasdzxc qweqwe qwe123 qwerty1234 qwerty12345 qwertyu asdasd asdasdasd asdfasdf zxczxc zxczxczxc
letmein123 welcome12 welcome2 welcome01 admin1234 admin12345 admin1 administrator1 root123 root1234
flower flowers rainbow butterfly1 sunflower iloveyou123 iloveme lovemylife nothing1 nothing
trustno12 starwars1 pokemon1 password2 password3 password01 password11 password99 passwort passwort1 contrasena
mypassword mypassword1 mypassword123 mypass mypass123 yourpassword newpassword newpass letmein2 opensesame open123
superman1 batman123 gundam naruto123 spongebob patrick barbie hellokitty hello1 hello12 hello1234 hello12345
liverpool arsenal chelsea manchester barcelona realmadrid juventus yankees redsox lakers steelers packers
canada canada123 america usa123 england london paris toronto ottawa vancouver montreal
qazwsxedc123 zaq1zaq1 zaq1xsw2 !qaz2wsx 1qaz!qaz 1q2w3e4r!
`
const LIST = [...new Set(WORDS.split(/\s+/).map((w) => w.trim().toLowerCase()).filter(Boolean))]
module.exports = { COMMON_PASSWORDS: LIST, COMMON_PASSWORD_SET: new Set(LIST) }
